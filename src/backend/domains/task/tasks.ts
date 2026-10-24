// Task domain (SPECIFICATION.md §2 T-01, §5 state transitions, T11): atomic
// task+conversation creation, parent depth/count bounds, CRUD, cancel/retry.
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  CreateTaskInput,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from '../../../contracts/task.ts';
import { DomainError } from '../../api/errors.ts';
import { eventHub } from '../../events/hub.ts';
import { getRepositoryById } from './repositories.ts';

export interface TaskRecord extends Task {
  conversationId: string;
}

export interface TaskRow {
  id: string;
  repository_id: string;
  conversation_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  depth: number;
  block_kind?: string | null;
  blocked_reason: string | null;
  blocked_on_child_ids: string | null;
  created_at: string;
  updated_at: string;
  version?: number;
}

export const TASK_COLUMNS = `id, repository_id, conversation_id, parent_id, title, description,
  priority, status, depth, block_kind, blocked_reason, blocked_on_child_ids, created_at, updated_at, version`;

const MAX_CHILDREN_PER_TASK = 5;

export function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    repoId: row.repository_id,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    parentId: row.parent_id,
    depth: row.depth === 1 ? 1 : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blockKind: row.block_kind ?? null,
    blockedReason: row.blocked_reason,
    blockedOnChildIds: row.blocked_on_child_ids
      ? (JSON.parse(row.blocked_on_child_ids) as string[])
      : null,
    activeRunId: null,
    version: row.version ?? 1,
    conversationId: row.conversation_id,
  };
}

export function getTaskById(db: Database, id: string): TaskRecord | null {
  const row = db.query(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | null;
  if (!row) return null;
  const task = rowToTask(row);
  const activeRun = db
    .query(
      "SELECT id, pending_input_request_id FROM runs WHERE task_id = ? AND status IN ('running', 'hitl') ORDER BY started_at DESC LIMIT 1",
    )
    .get(id) as { id: string; pending_input_request_id: string | null } | null;
  if (activeRun) {
    task.activeRunId = activeRun.id;
    task.pendingInputRequestId = activeRun.pending_input_request_id;
  }
  return task;
}

function requireTask(db: Database, id: string): TaskRecord {
  const task = getTaskById(db, id);
  if (!task) {
    throw new DomainError('NOT_FOUND', `task not found: ${id}`);
  }
  return task;
}

function countChildren(db: Database, parentId: string): number {
  const row = db.query('SELECT COUNT(*) as count FROM tasks WHERE parent_id = ?').get(parentId) as {
    count: number;
  };
  return row.count;
}

export function createTask(db: Database, input: CreateTaskInput): TaskRecord {
  const repository = getRepositoryById(db, input.repoId);
  if (!repository) {
    throw new DomainError('NOT_FOUND', `repository not found: ${input.repoId}`);
  }

  let depth: 0 | 1 = 0;
  if (input.parentId) {
    const parent = getTaskById(db, input.parentId);
    if (!parent) {
      throw new DomainError('NOT_FOUND', `parent task not found: ${input.parentId}`);
    }
    if (parent.depth !== 0) {
      throw new DomainError(
        'CHILD_LIMIT_EXCEEDED',
        'parent task is itself a child; grandchildren are not allowed',
      );
    }
    if (countChildren(db, parent.id) >= MAX_CHILDREN_PER_TASK) {
      throw new DomainError(
        'CHILD_LIMIT_EXCEEDED',
        `parent task already has the maximum of ${MAX_CHILDREN_PER_TASK} children`,
      );
    }
    depth = 1;
  }

  const id = randomUUID();
  const conversationId = randomUUID();
  const now = new Date().toISOString();
  const priority = input.priority ?? 'P2';

  const applyAtomically = db.transaction(() => {
    db.query('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(
      conversationId,
      now,
      now,
    );
    db.query(
      `INSERT INTO tasks
        (id, repository_id, conversation_id, parent_id, title, description, priority, status,
         agent_provider, block_kind, blocked_reason, depth, blocked_on_child_ids, origin_run_id,
         origin_key, created_at, enqueued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(
      id,
      repository.id,
      conversationId,
      input.parentId ?? null,
      input.title,
      input.description ?? null,
      priority,
      repository.defaultProvider,
      depth,
      now,
      now,
      now,
    );
  });
  applyAtomically();

  const created = requireTask(db, id);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: created.id,
      status: created.status,
      version: created.version,
      blockedReason: created.blockedReason,
      updatedAt: created.updatedAt,
    },
  });
  return created;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  repositoryId?: string;
  query?: string;
}

export function listTasks(db: Database, filter: ListTasksFilter): TaskRecord[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.priority) {
    clauses.push('priority = ?');
    params.push(filter.priority);
  }
  if (filter.repositoryId) {
    clauses.push('repository_id = ?');
    params.push(filter.repositoryId);
  }
  if (filter.query) {
    clauses.push('(title LIKE ? OR description LIKE ? OR id LIKE ?)');
    const likeQuery = `%${filter.query}%`;
    params.push(likeQuery, likeQuery, likeQuery);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .query(`SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY created_at ASC, id ASC`)
    .all(...params) as TaskRow[];

  const activeRuns = db
    .query(
      "SELECT id, task_id, pending_input_request_id FROM runs WHERE status IN ('running', 'hitl')",
    )
    .all() as Array<{ id: string; task_id: string; pending_input_request_id: string | null }>;
  const activeRunByTask = new Map<string, { id: string; pendingInputRequestId: string | null }>();
  for (const r of activeRuns) {
    activeRunByTask.set(r.task_id, { id: r.id, pendingInputRequestId: r.pending_input_request_id });
  }

  return rows.map((r) => {
    const t = rowToTask(r);
    const active = activeRunByTask.get(t.id);
    if (active) {
      t.activeRunId = active.id;
      t.pendingInputRequestId = active.pendingInputRequestId;
    }
    return t;
  });
}

export function updateTask(db: Database, id: string, input: UpdateTaskInput): TaskRecord {
  const task = requireTask(db, id);
  if (task.status === 'processing') {
    throw new DomainError('INVALID_TRANSITION', 'cannot edit a task while it is processing');
  }

  const now = new Date().toISOString();
  db.query(
    'UPDATE tasks SET title = ?, description = ?, priority = ?, updated_at = ?, version = version + 1 WHERE id = ?',
  ).run(
    input.title ?? task.title,
    input.description ?? task.description ?? null,
    input.priority ?? task.priority,
    now,
    id,
  );

  const updated = requireTask(db, id);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: updated.id,
      status: updated.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: updated.updatedAt,
    },
  });
  return updated;
}

/**
 * Cancels a task that is NOT currently live (no active run to stop): 'todo'
 * or 'error'. A live task ('processing' or 'hitl') must go through
 * `requestRunCancellationForTask` in runs.ts instead, since cancelling a live
 * task requires verified process-stop evidence before the lock can release
 * (specs/2026-10-24-handoff-single-writer.md A10) — `cancelTask` alone cannot
 * safely do that without reaching into run/lock state, which is `runs.ts`'s
 * domain. `src/backend/api/tasks.ts` routes to the right one by status.
 */
export function cancelTask(db: Database, id: string): TaskRecord {
  const task = requireTask(db, id);
  if (task.status === 'done' || task.status === 'cancelled') {
    return task;
  }

  if (task.status !== 'todo' && task.status !== 'error') {
    throw new DomainError('INVALID_TRANSITION', `cannot cancel task in status '${task.status}'`);
  }

  const now = new Date().toISOString();
  db.query('UPDATE tasks SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(
    'cancelled',
    now,
    id,
  );
  const updated = requireTask(db, id);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: updated.id,
      status: updated.status,
      previousStatus: task.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: updated.updatedAt,
    },
  });

  reconcileBlockedParents(db);

  return updated;
}

export function reconcileBlockedParents(db: Database): void {
  const rows = db
    .query(
      `SELECT id, blocked_on_child_ids, blocked_reason, version
       FROM tasks
       WHERE status = 'todo' AND block_kind = 'children' AND blocked_on_child_ids IS NOT NULL`,
    )
    .all() as {
    id: string;
    blocked_on_child_ids: string | null;
    blocked_reason: string | null;
    version: number;
  }[];

  const now = new Date().toISOString();

  for (const row of rows) {
    let childIds: string[] = [];
    try {
      childIds = JSON.parse(row.blocked_on_child_ids ?? '[]');
    } catch {
      continue;
    }

    if (childIds.length === 0) {
      db.query(
        `UPDATE tasks
         SET block_kind = NULL, blocked_reason = NULL, updated_at = ?, version = version + 1
         WHERE id = ?`,
      ).run(now, row.id);
      eventHub.publish({
        type: 'task.status_changed',
        data: {
          taskId: row.id,
          status: 'todo',
          version: row.version + 1,
          blockedReason: null,
          updatedAt: now,
        },
      });
      continue;
    }

    const placeholders = childIds.map(() => '?').join(',');
    const children = db
      .query(`SELECT id, status, blocked_reason FROM tasks WHERE id IN (${placeholders})`)
      .all(...childIds) as { id: string; status: string; blocked_reason: string | null }[];

    if (children.length < childIds.length) {
      continue;
    }

    const allTerminal = children.every((c) => ['done', 'error', 'cancelled'].includes(c.status));
    if (!allTerminal) {
      continue;
    }

    const failedOrCancelled = children.filter(
      (c) => c.status === 'error' || c.status === 'cancelled',
    );
    if (failedOrCancelled.length > 0) {
      const failedSummary = failedOrCancelled
        .map((c) => `Child ${c.id} (${c.status}${c.blocked_reason ? `: ${c.blocked_reason}` : ''})`)
        .join(', ');
      const newBlockedReason = `Child task failed or cancelled: ${failedSummary}`;

      if (row.blocked_reason !== newBlockedReason) {
        db.query(
          `UPDATE tasks
           SET blocked_reason = ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        ).run(newBlockedReason, now, row.id);
        eventHub.publish({
          type: 'task.status_changed',
          data: {
            taskId: row.id,
            status: 'todo',
            version: row.version + 1,
            blockedReason: newBlockedReason,
            updatedAt: now,
          },
        });
      }
    } else {
      // All children are done! Unblock parent
      db.query(
        `UPDATE tasks
         SET block_kind = NULL, blocked_reason = NULL, updated_at = ?, version = version + 1
         WHERE id = ?`,
      ).run(now, row.id);
      eventHub.publish({
        type: 'task.status_changed',
        data: {
          taskId: row.id,
          status: 'todo',
          version: row.version + 1,
          blockedReason: null,
          updatedAt: now,
        },
      });
    }
  }
}

export function retryTask(db: Database, id: string): TaskRecord {
  const task = requireTask(db, id);
  if (task.status !== 'error') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `cannot retry task in status '${task.status}'; only 'error' tasks may be retried`,
    );
  }

  const repository = getRepositoryById(db, task.repoId);
  if (repository) {
    const lock = db
      .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
      .get(repository.canonicalPath) as { quarantined: number } | null;
    if (lock?.quarantined === 1) {
      throw new DomainError('LOCK_HELD', 'working tree is quarantined');
    }
  }

  const now = new Date().toISOString();
  db.query(
    `UPDATE tasks SET status = 'todo', blocked_reason = NULL, enqueued_at = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(now, now, id);
  const updated = requireTask(db, id);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: updated.id,
      status: updated.status,
      previousStatus: task.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: updated.updatedAt,
    },
  });
  return updated;
}
