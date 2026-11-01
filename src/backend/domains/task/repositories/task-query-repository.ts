// Task query and projection database access (SPECIFICATION.md §2, TASKS.md T11, LC-03a).
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type {
  Provider,
  Task,
  TaskPriority,
  TaskStage,
  TaskStatus,
} from '../../../../contracts/task.ts';

export interface TaskRecord extends Task {
  conversationId: string;
  // Internal-only (not part of the public Task wire contract): whether the
  // original create request supplied an explicit title/priority, which
  // commit-intake-result-usecase.ts must preserve unchanged regardless of
  // what Intake's JSON echoes back (03-agent-routing.md "Keep explicit user
  // title and priority").
  titleIsOverride?: boolean;
  priorityIsOverride?: boolean;
}

export interface TaskRow {
  id: string;
  repository_id: string | null;
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
  candidate_repo_ids: string | null;
  authorized_repo_ids: string | null;
  resolved_repo_ids: string | null;
  stage: string;
  execution_provider: string | null;
  intake_revision: number;
  initial_message_id: string | null;
  intake_pending_request_id: string | null;
  title_is_override: number;
  priority_is_override: number;
}

export const TASK_COLUMNS = `id, repository_id, conversation_id, parent_id, title, description,
  priority, status, depth, block_kind, blocked_reason, blocked_on_child_ids, created_at, updated_at,
  version, candidate_repo_ids, authorized_repo_ids, resolved_repo_ids, stage, execution_provider,
  intake_revision, initial_message_id, intake_pending_request_id, title_is_override, priority_is_override`;

function parseJsonArray(value: string | null): string[] | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as string[];
  } catch {
    return null;
  }
}

export function rowToTask(row: TaskRow): TaskRecord {
  // Legacy/resolved single-repo tasks never had resolvedRepoIds populated as
  // a JSON column; fall back to the primary repoId so callers have one
  // consistent place to read the accepted scope regardless of row age.
  const resolvedRepoIds = parseJsonArray(row.resolved_repo_ids) ?? (row.repository_id ? [row.repository_id] : null);

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    repoId: row.repository_id,
    candidateRepoIds: parseJsonArray(row.candidate_repo_ids),
    authorizedRepoIds: parseJsonArray(row.authorized_repo_ids),
    resolvedRepoIds,
    stage: (row.stage as TaskStage) ?? 'ready',
    executionProvider: (row.execution_provider as Provider | null) ?? null,
    intakeRevision: row.intake_revision ?? 0,
    initialMessageId: row.initial_message_id,
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
    titleIsOverride: row.title_is_override === 1,
    priorityIsOverride: row.priority_is_override === 1,
  };
}

export function findTaskRowById(db: Database, id: string): TaskRow | null {
  return db.query(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | null;
}

export function findActiveRunForTask(
  db: Database,
  taskId: string,
): { id: string; pendingInputRequestId: string | null } | null {
  const row = db
    .query(
      "SELECT id, pending_input_request_id FROM runs WHERE task_id = ? AND status IN ('running', 'hitl') ORDER BY started_at DESC LIMIT 1",
    )
    .get(taskId) as { id: string; pending_input_request_id: string | null } | null;
  if (!row) return null;
  return {
    id: row.id,
    pendingInputRequestId: row.pending_input_request_id,
  };
}

export function findActiveRunsForTasks(
  db: Database,
): Map<string, { id: string; pendingInputRequestId: string | null }> {
  const activeRuns = db
    .query(
      "SELECT id, task_id, pending_input_request_id FROM runs WHERE status IN ('running', 'hitl')",
    )
    .all() as Array<{ id: string; task_id: string; pending_input_request_id: string | null }>;
  const activeRunByTask = new Map<string, { id: string; pendingInputRequestId: string | null }>();
  for (const r of activeRuns) {
    activeRunByTask.set(r.task_id, {
      id: r.id,
      pendingInputRequestId: r.pending_input_request_id,
    });
  }
  return activeRunByTask;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  repositoryId?: string;
  query?: string;
}

export function findTaskRows(db: Database, filter: ListTasksFilter): TaskRow[] {
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
    // Matches the resolved repo, and also a still-unresolved (stage
    // 'intake') task that has this repo as an explicit candidate hint —
    // otherwise filtering "by repository" would hide every task still
    // awaiting Intake, including ones the user explicitly hinted at this
    // repo (specs/2026-10-25-message-intake). Deliberately excludes
    // `authorized_repo_ids` — that is the whole registered catalog for most
    // browser-created tasks, which would make this filter match almost
    // everything.
    clauses.push(`(repository_id = ? OR candidate_repo_ids LIKE ?)`);
    params.push(filter.repositoryId, `%"${filter.repositoryId}"%`);
  }
  if (filter.query) {
    clauses.push('(title LIKE ? OR description LIKE ? OR id LIKE ?)');
    const likeQuery = `%${filter.query}%`;
    params.push(likeQuery, likeQuery, likeQuery);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .query(`SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY created_at ASC, id ASC`)
    .all(...params) as TaskRow[];
}

export interface ChildTaskSummary {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  errorMessage: string | null;
}

export function findChildTaskSummaries(db: Database, parentTaskId: string): ChildTaskSummary[] {
  const childRows = db
    .query(
      'SELECT id, title, status, blocked_reason FROM tasks WHERE parent_id = ? ORDER BY created_at ASC',
    )
    .all(parentTaskId) as {
    id: string;
    title: string;
    status: string;
    blocked_reason: string | null;
  }[];

  return childRows.map((child) => {
    const latestRun = db
      .query('SELECT process_state FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(child.id) as { process_state: string | null } | null;
    let summary: string | null = null;
    let errorMessage: string | null = child.blocked_reason;
    if (latestRun?.process_state) {
      try {
        const parsed = JSON.parse(latestRun.process_state);
        summary = parsed.summary ?? null;
        if (!errorMessage && parsed.errorMessage) {
          errorMessage = parsed.errorMessage;
        }
      } catch {}
    }
    return {
      id: child.id,
      title: child.title,
      status: child.status,
      summary,
      errorMessage,
    };
  });
}

export function findConversationRow(
  db: Database,
  conversationId: string,
): { id: string; created_at: string; updated_at: string } | null {
  return db
    .query('SELECT id, created_at, updated_at FROM conversations WHERE id = ?')
    .get(conversationId) as { id: string; created_at: string; updated_at: string } | null;
}
