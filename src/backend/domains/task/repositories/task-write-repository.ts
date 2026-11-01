// Task write database access (SPECIFICATION.md §2, TASKS.md T11, LC-03b, LC-03c, LC-03d, LC-04b, LC-04c).
import type { Database } from 'bun:sqlite';
import type { TaskPriority, TaskStage } from '../../../../contracts/task.ts';

export interface InsertTaskParams {
  id: string;
  // Null until Intake resolves a scope (stage: 'intake'); set immediately
  // for a legacy-style caller that already named exactly one repo id (then
  // stage: 'ready' and this doubles as the resolved scope).
  repositoryId: string | null;
  conversationId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  agentProvider: string;
  depth: 0 | 1;
  createdAt: string;
  enqueuedAt: string;
  updatedAt: string;
  candidateRepoIds: string[] | null;
  authorizedRepoIds: string[] | null;
  resolvedRepoIds: string[] | null;
  stage: TaskStage;
  blockedOnChildIds?: string[] | null;
  blockKind?: string | null;
  blockedReason?: string | null;
  titleIsOverride: boolean;
  priorityIsOverride: boolean;
  originRunId?: string | null;
  originKey?: string | null;
}

export function countChildrenByParentId(db: Database, parentId: string): number {
  const row = db.query('SELECT COUNT(*) as count FROM tasks WHERE parent_id = ?').get(parentId) as {
    count: number;
  };
  return row.count;
}

export function insertTask(db: Database, params: InsertTaskParams): void {
  db.query(
    `INSERT INTO tasks
      (id, repository_id, conversation_id, parent_id, title, description, priority, status,
       agent_provider, block_kind, blocked_reason, depth, blocked_on_child_ids, origin_run_id,
       origin_key, created_at, enqueued_at, updated_at,
       candidate_repo_ids, authorized_repo_ids, resolved_repo_ids, stage,
       title_is_override, priority_is_override)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.repositoryId,
    params.conversationId,
    params.parentId,
    params.title,
    params.description,
    params.priority,
    params.agentProvider,
    params.blockKind ?? null,
    params.blockedReason ?? null,
    params.depth,
    params.blockedOnChildIds ? JSON.stringify(params.blockedOnChildIds) : null,
    params.originRunId ?? null,
    params.originKey ?? null,
    params.createdAt,
    params.enqueuedAt,
    params.updatedAt,
    params.candidateRepoIds ? JSON.stringify(params.candidateRepoIds) : null,
    params.authorizedRepoIds ? JSON.stringify(params.authorizedRepoIds) : null,
    params.resolvedRepoIds ? JSON.stringify(params.resolvedRepoIds) : null,
    params.stage,
    params.titleIsOverride ? 1 : 0,
    params.priorityIsOverride ? 1 : 0,
  );
}

export function setTaskInitialMessageId(db: Database, taskId: string, messageId: string): void {
  db.query('UPDATE tasks SET initial_message_id = ? WHERE id = ?').run(messageId, taskId);
}

export function updateTaskRecord(
  db: Database,
  params: {
    id: string;
    title: string;
    priority: string;
    updatedAt: string;
  },
): void {
  db.query(
    'UPDATE tasks SET title = ?, priority = ?, updated_at = ?, version = version + 1 WHERE id = ?',
  ).run(params.title, params.priority, params.updatedAt, params.id);
}

/** Commits Intake's accepted `implement` result: resolves repo scope,
 * provider, title/priority (when not already a fixed caller override) and
 * flips the task to stage 'ready' so the existing admission query can claim
 * it against `repository_id` (01-contracts-and-lifecycle.md "Admission ...
 * Implementation attempt"). */
export function resolveTaskFromIntake(
  db: Database,
  params: {
    id: string;
    title: string;
    priority: string;
    primaryRepoId: string;
    resolvedRepoIds: string[];
    executionProvider: string;
    intakeResultJson: string;
    updatedAt: string;
  },
): void {
  db.query(
    `UPDATE tasks SET
       title = ?, priority = ?, repository_id = ?, resolved_repo_ids = ?,
       execution_provider = ?, agent_provider = ?, stage = 'ready', status = 'todo',
       intake_result = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(
    params.title,
    params.priority,
    params.primaryRepoId,
    JSON.stringify(params.resolvedRepoIds),
    params.executionProvider,
    params.executionProvider,
    params.intakeResultJson,
    params.updatedAt,
    params.id,
  );
}

/** Intake's `request_input` outcome (01-contracts-and-lifecycle.md "For
 * Intake request_input, persist a request bound to task/input revision and
 * the stopped Intake attempt; task becomes hitl, without a retained active
 * run or slot."). Unlike implementation HITL, there is no run to keep
 * `running`/`hitl` — the Intake attempt already finalized as `done` by the
 * time this is called, so it never counts against the active-run cap. */
export function recordIntakePendingQuestion(
  db: Database,
  params: { taskId: string; requestId: string; question: string; updatedAt: string },
): void {
  db.query(
    `UPDATE tasks SET status = 'hitl', intake_pending_request_id = ?, intake_pending_question = ?,
       updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(params.requestId, params.question, params.updatedAt, params.taskId);
}

/** One matching reply "appends the answer and queues fresh Intake atomically"
 * (01-contracts-and-lifecycle.md): clears the checkpoint, bumps the
 * revision so a stale/duplicate reply can never queue a second attempt, and
 * returns the task to 'todo' (stage stays 'intake') so the next admission
 * poll claims a brand-new bounded Intake attempt. */
export function resolveIntakePendingQuestion(
  db: Database,
  taskId: string,
  updatedAt: string,
): void {
  db.query(
    `UPDATE tasks SET status = 'todo', intake_pending_request_id = NULL, intake_pending_question = NULL,
       intake_revision = intake_revision + 1, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(updatedAt, taskId);
}

/** Finalizes an Intake attempt's own run row (status + ended_at + a small
 * process_state summary) WITHOUT touching run_locks — an Intake run never
 * held one (claim-intake-usecase.ts). This IS the Intake attempt's
 * finalization (01-contracts-and-lifecycle.md), replacing the generic
 * finalize endpoint implementation runs use. */
export function finalizeIntakeRun(
  db: Database,
  runId: string,
  outcome: 'implement' | 'delegate' | 'request_input' | 'failed',
  now: string,
): void {
  db.query(
    `UPDATE runs SET status = 'done', ended_at = ?, process_state = ?, terminal_outcome = ? WHERE id = ?`,
  ).run(now, JSON.stringify({ intakeOutcome: outcome }), outcome, runId);
}

/** Activates an ordinary delegated child once the parent's `delegate`
 * outcome is accepted (01-contracts-and-lifecycle.md "On delegate,
 * atomically finish the verified-stopped parent as done ... and activate
 * children"): clears the staging block so it becomes an ordinary eligible
 * task, starting its own Intake attempt. */
export function activateStagedChild(db: Database, childId: string, now: string): void {
  db.query(
    `UPDATE tasks SET block_kind = NULL, blocked_reason = NULL, blocked_on_child_ids = NULL,
       updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(now, childId);
}

/** Promotes a staged verification task to the ordinary bounded-prerequisite
 * wait (04-delegation-and-follow-up.md): its `waitForTaskIds` were already
 * stored as `blocked_on_child_ids` at creation, so this only needs to swap
 * the block kind — reconcileBlockedParents (tasks.ts) does the rest once
 * every listed id is terminal. */
export function promoteStagedVerificationTask(db: Database, taskId: string, now: string): void {
  db.query(
    `UPDATE tasks SET block_kind = 'prerequisites',
       blocked_reason = 'Waiting for prerequisite tasks to finish',
       updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(now, taskId);
}

/** Parent completion on accepted delegation (04-delegation-and-follow-up.md
 * "Parent `done` means delegation completed, not that the delegated
 * implementation succeeded."). No lock to release — Intake never held one. */
export function completeTaskAsDelegated(db: Database, taskId: string, now: string): void {
  db.query(
    `UPDATE tasks SET status = 'done', stage = 'ready', updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(now, taskId);
}

/** Invalid/missing Intake output, or a non-'done' terminal status, becomes
 * task `error` for explicit retry — never an automatic repair loop
 * (01-contracts-and-lifecycle.md). Stage stays 'intake' so retryTaskUsecase
 * re-queues a fresh Intake attempt, not an implementation claim. */
export function failTaskIntake(db: Database, taskId: string, reason: string, now: string): void {
  db.query(
    `UPDATE tasks SET status = 'error', blocked_reason = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(reason, now, taskId);
}

export function bumpIntakeRevision(db: Database, taskId: string): number {
  db.query('UPDATE tasks SET intake_revision = intake_revision + 1 WHERE id = ?').run(taskId);
  const row = db.query('SELECT intake_revision FROM tasks WHERE id = ?').get(taskId) as {
    intake_revision: number;
  };
  return row.intake_revision;
}

export function cancelTaskRecord(db: Database, id: string, updatedAt: string): void {
  db.query('UPDATE tasks SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(
    'cancelled',
    updatedAt,
    id,
  );
}

export function retryTaskRecord(db: Database, id: string, now: string): void {
  db.query(
    `UPDATE tasks SET status = 'todo', blocked_reason = NULL, enqueued_at = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(now, now, id);
}

export function isWorkingTreeQuarantined(db: Database, canonicalPath: string): boolean {
  const lock = db
    .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
    .get(canonicalPath) as { quarantined: number } | null;
  return lock?.quarantined === 1;
}

export function resumeTaskFromHitl(db: Database, taskId: string, now: string): void {
  markTaskProcessing(db, taskId, now);
}

export function markTaskProcessing(db: Database, taskId: string, now: string): void {
  db.query(
    "UPDATE tasks SET status = 'processing', updated_at = ?, version = version + 1 WHERE id = ?",
  ).run(now, taskId);
}

export function markTaskHitl(db: Database, taskId: string, now: string): void {
  db.query(
    "UPDATE tasks SET status = 'hitl', updated_at = ?, version = version + 1 WHERE id = ?",
  ).run(now, taskId);
}
