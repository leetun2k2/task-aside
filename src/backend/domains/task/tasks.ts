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
import { DomainError } from '../../errors.ts';
import { eventHub } from '../../events/hub.ts';
import { getRepositoryById } from './repositories.ts';
import {
  type ListTasksFilter,
  TASK_COLUMNS,
  type TaskRecord,
  type TaskRow,
  rowToTask,
} from './repositories/task-query-repository.ts';
import { resolveTaskFromIntake } from './repositories/task-write-repository.ts';
import { cancelTaskUsecase } from './usecases/cancel-task-usecase.ts';
import { createTaskUsecase } from './usecases/create-task-usecase.ts';
import { getTaskUsecase, requireTaskUsecase } from './usecases/get-task-usecase.ts';
import { listTasksUsecase } from './usecases/list-tasks-usecase.ts';
import { retryTaskUsecase } from './usecases/retry-task-usecase.ts';
import { updateTaskUsecase } from './usecases/update-task-usecase.ts';

export type { TaskRecord, TaskRow, ListTasksFilter };
export { TASK_COLUMNS, rowToTask };

export function getTaskById(db: Database, id: string): TaskRecord | null {
  return getTaskUsecase(db, id);
}

export function requireTask(db: Database, id: string): TaskRecord {
  return requireTaskUsecase(db, id);
}

export function listTasks(db: Database, filter: ListTasksFilter): TaskRecord[] {
  return listTasksUsecase(db, filter);
}

/**
 * Pre-feature test/check convenience helper (specs/2026-10-25-message-
 * intake): every real create path now goes through `createTaskUsecase`
 * (Message-first, always starts `stage: 'intake'`). Many existing
 * scheduler/locking/pool check suites (engine-checks.ts, pool-checks.ts,
 * run-checks.ts, ...) create a task with an explicit `repoId` and expect it
 * immediately admittable against that repo — exactly what a resolved,
 * `stage: 'ready'` task looks like after a real Intake attempt accepts an
 * `implement` outcome. This wraps both steps so none of those call sites
 * (which only ever used this old `{repoId, title, priority}` shape) needed
 * to change: it is a test fixture, not a shortcut available to application
 * code (no other module imports `createTask` from this facade).
 */
export function createTask(
  db: Database,
  input: {
    repoId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    parentId?: string | null;
  },
): TaskRecord {
  const created = createTaskUsecase(db, {
    message: input.description?.trim() || input.title,
    title: input.title,
    repoId: input.repoId,
    priority: input.priority,
    parentId: input.parentId ?? undefined,
  });

  const repository = getRepositoryById(db, input.repoId);
  if (!repository) {
    throw new DomainError('NOT_FOUND', `repository not found: ${input.repoId}`);
  }

  resolveTaskFromIntake(db, {
    id: created.id,
    title: input.title,
    priority: input.priority ?? created.priority,
    primaryRepoId: input.repoId,
    resolvedRepoIds: [input.repoId],
    executionProvider: repository.defaultProvider,
    intakeResultJson: JSON.stringify({ test: true }),
    updatedAt: created.updatedAt,
  });

  // `resolveTaskFromIntake` bumps `version` (correct for the real Intake
  // commit path, where the task may already have been edited since
  // creation) — but existing check suites assert this fixture's return
  // value starts at version 1, exactly like a task created and resolved in
  // one step used to. Reset it here rather than touch every call site.
  db.query('UPDATE tasks SET version = 1 WHERE id = ?').run(created.id);

  return requireTaskUsecase(db, created.id);
}

export function updateTask(db: Database, id: string, input: UpdateTaskInput): TaskRecord {
  return updateTaskUsecase(db, id, input);
}

export function cancelTask(db: Database, id: string): TaskRecord {
  return cancelTaskUsecase(db, id);
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
  return retryTaskUsecase(db, id);
}
