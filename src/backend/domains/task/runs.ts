// Fenced run lifecycle domain (SPECIFICATION.md §3, §5, §7; T12): atomic
// claim/run/lock transaction, heartbeat, finalize with verified-stop, mark
// uncertain/quarantine, clear-quarantine admin recovery, runnable candidates
// and instruction-context assembly. Only `src/backend` may open SQLite
// (AGENTS.md §3).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { Message } from '../../../contracts/chat.ts';
import { MAX_WORKERS, TASK_TIMEOUT_MS } from '../../../contracts/pool.ts';
import type {
  AdmitSkipReason,
  ClaimTaskRequest,
  ClaimTaskResponse,
  ClearQuarantineRequest,
  FinalizeRunRequest,
  HeartbeatRequest,
  MarkUncertainRequest,
  RunStatus,
} from '../../../contracts/run.ts';
import type { Repository } from '../../../contracts/task.ts';
import { DomainError } from '../../errors.ts';
import { eventHub } from '../../events/hub.ts';
import { listMessages } from '../chat/messages.ts';
import { getRepositoryById } from './repositories.ts';
import {
  TASK_COLUMNS,
  type TaskRecord,
  type TaskRow,
  getTaskById,
  reconcileBlockedParents,
  rowToTask,
} from './tasks.ts';

export const LEASE_DURATION_MS = 30_000;
export const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['running', 'hitl']);
export const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['done', 'error', 'cancelled']);

export interface RunRow {
  id: string;
  task_id: string;
  provider: string;
  status: RunStatus;
  owner_token: string;
  lock_generation: number;
  process_state: string | null;
  pending_input_request_id: string | null;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  exit_code: number | null;
  pending_yield_child_ids?: string | null;
  pending_yield_reason?: string | null;
  cancel_requested_at?: string | null;
  deadline_at?: string | null;
  timeout_requested_at?: string | null;
}

export interface ClaimReceiptRow {
  task_id: string;
  run_id: string;
  generation: number;
}

export function getClaimReceipt(
  db: Database,
  ownerId: string,
  idempotencyKey: string,
): ClaimReceiptRow | null {
  return db
    .query(
      'SELECT task_id, run_id, generation FROM claim_receipts WHERE owner_id = ? AND idempotency_key = ?',
    )
    .get(ownerId, idempotencyKey) as ClaimReceiptRow | null;
}

/** Durable 60-minute deadline, computed once at claim time; legacy runs from
 * before this column existed fall back to startedAt + TASK_TIMEOUT_MS at read
 * time rather than guessing via a migration UPDATE. */
export function effectiveDeadline(run: Pick<RunRow, 'deadline_at' | 'started_at'>): string {
  return (
    run.deadline_at ?? new Date(new Date(run.started_at).getTime() + TASK_TIMEOUT_MS).toISOString()
  );
}

/** Effective admission ceiling: min(configured settings.maxConcurrency, MAX_WORKERS).
 * Existing values above 8 remain accepted/stored but never raise the real cap. */
export function getEffectiveMaxConcurrency(db: Database): number {
  const row = db.query('SELECT max_concurrency FROM settings WHERE id = 1').get() as {
    max_concurrency: number;
  } | null;
  const configured = row?.max_concurrency ?? MAX_WORKERS;
  return Math.min(configured, MAX_WORKERS);
}

/** Shared, DB-backed occupancy count — the authority multiple engine
 * processes against one backend must agree on; in-memory scheduler state is
 * a cache only. */
export function countActiveRuns(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM runs WHERE status IN ('running', 'hitl')")
    .get() as { count: number };
  return row.count;
}

export interface RunLockRow {
  working_tree_key: string;
  owner_run_id: string;
  generation: number;
  lease_expires_at: string;
  quarantined: number;
}

export function requireTask(db: Database, id: string): TaskRecord {
  const task = getTaskById(db, id);
  if (!task) {
    throw new DomainError('NOT_FOUND', `task not found: ${id}`);
  }
  return task;
}

const RUN_COLUMNS = `id, task_id, provider, status, owner_token, lock_generation, process_state,
   pending_input_request_id, started_at, heartbeat_at, ended_at, exit_code,
   cancel_requested_at, deadline_at, timeout_requested_at`;

export function getRunById(db: Database, id: string): RunRow | null {
  return db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as RunRow | null;
}

export function requireRun(db: Database, id: string): RunRow {
  const run = getRunById(db, id);
  if (!run) {
    throw new DomainError('NOT_FOUND', `run not found: ${id}`);
  }
  return run;
}

export function getLockByKey(db: Database, workingTreeKey: string): RunLockRow | null {
  return db
    .query(
      `SELECT working_tree_key, owner_run_id, generation, lease_expires_at, quarantined
       FROM run_locks WHERE working_tree_key = ?`,
    )
    .get(workingTreeKey) as RunLockRow | null;
}

export function getLockForRun(db: Database, runId: string): RunLockRow | null {
  return db
    .query(
      `SELECT working_tree_key, owner_run_id, generation, lease_expires_at, quarantined
       FROM run_locks WHERE owner_run_id = ?`,
    )
    .get(runId) as RunLockRow | null;
}

export interface PendingYieldIntent {
  childTaskIds: string[];
  reason: string | null;
}

const ACTIVE_RUN_FENCE_STATUSES = new Set<RunStatus>(['running', 'hitl']);

export function getPendingYield(db: Database, runId: string): PendingYieldIntent | null {
  const row = db
    .query('SELECT pending_yield_child_ids, pending_yield_reason FROM runs WHERE id = ?')
    .get(runId) as {
    pending_yield_child_ids: string | null;
    pending_yield_reason: string | null;
  } | null;
  if (!row || row.pending_yield_child_ids === null) {
    return null;
  }
  let childTaskIds: string[] = [];
  try {
    childTaskIds = JSON.parse(row.pending_yield_child_ids) as string[];
  } catch {
    childTaskIds = [];
  }
  return { childTaskIds, reason: row.pending_yield_reason };
}

function sameIntent(a: PendingYieldIntent, b: PendingYieldIntent): boolean {
  const aSorted = [...a.childTaskIds].sort();
  const bSorted = [...b.childTaskIds].sort();
  if (aSorted.length !== bSorted.length) {
    return false;
  }
  if (aSorted.some((id, i) => id !== bSorted[i])) {
    return false;
  }
  return (a.reason ?? null) === (b.reason ?? null);
}

/**
 * Records a yield intent on the run WITHOUT touching task status, run status
 * or run_locks — a yield request is intent, never proof of process exit
 * (specs/2026-10-24-handoff-single-writer.md). Ownership stays held until a
 * trusted adapter stop evidence finalizes the run (see `finalizeRun`).
 * Repeating an identical pending intent is a no-op (idempotent); a different
 * intent while one is pending is rejected.
 */
export function recordYieldIntent(
  db: Database,
  runId: string,
  intent: { childTaskIds: string[]; reason: string | null },
): { ok: true; idempotent: boolean } {
  const run = requireRun(db, runId);
  if (!ACTIVE_RUN_FENCE_STATUSES.has(run.status)) {
    throw new DomainError(
      'INVALID_TRANSITION',
      `cannot yield run ${runId} in status '${run.status}'; run must be running or hitl`,
    );
  }

  const existing = getPendingYield(db, runId);
  const requested: PendingYieldIntent = {
    childTaskIds: intent.childTaskIds,
    reason: intent.reason,
  };

  if (existing) {
    if (sameIntent(existing, requested)) {
      return { ok: true, idempotent: true };
    }
    throw new DomainError(
      'VALIDATION_ERROR',
      `run ${runId} already has a pending yield intent with a different scope`,
    );
  }

  db.query(
    'UPDATE runs SET pending_yield_child_ids = ?, pending_yield_reason = ? WHERE id = ?',
  ).run(JSON.stringify(requested.childTaskIds), requested.reason, runId);

  return { ok: true, idempotent: false };
}

export function requestCancel(db: Database, runId: string): { ok: true } {
  db.query(
    'UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ?',
  ).run(new Date().toISOString(), runId);
  return { ok: true };
}

/**
 * Cooperative timeout-request marker, mirroring `requestCancel`: durable so a
 * restarted engine doesn't need to re-derive "did I already ask for this"
 * from memory alone, and idempotent (COALESCE) so repeated control-loop ticks
 * don't re-trigger termination for the same attempt.
 */
export function requestTimeout(db: Database, runId: string): { ok: true } {
  db.query(
    'UPDATE runs SET timeout_requested_at = COALESCE(timeout_requested_at, ?) WHERE id = ?',
  ).run(new Date().toISOString(), runId);
  return { ok: true };
}

/**
 * Requests cancellation of a live task ('processing' or 'hitl'). Verified
 * termination must precede cancellation release (A10): this does NOT flip the
 * task to 'cancelled' — it only marks the active run's cancel request. The
 * execution engine observes `cancel_requested_at`, cancels on the adapter
 * with verified-stop proof, and only then calls `finalizeRun` with
 * status:'cancelled', which is what actually transitions the task.
 */
export function requestRunCancellationForTask(db: Database, taskId: string): TaskRecord {
  const task = requireTask(db, taskId);
  if (task.status !== 'processing' && task.status !== 'hitl') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `cannot request cancellation for task ${taskId} in status '${task.status}'`,
    );
  }
  const run = getActiveRunForTask(db, taskId);
  if (!run) {
    throw new DomainError(
      'INVALID_TRANSITION',
      `task ${taskId} is ${task.status} but has no active run to cancel`,
    );
  }
  requestCancel(db, run.id);
  return task;
}

export function getActiveRunForTask(db: Database, taskId: string): RunRow | null {
  return db
    .query(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE task_id = ? AND status IN ('running', 'hitl')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId) as RunRow | null;
}

function rowToRunStatusRecord(run: RunRow): RunStatusRecord {
  return {
    runId: run.id,
    taskId: run.task_id,
    provider: run.provider,
    status: run.status,
    ownerId: run.owner_token,
    generation: run.lock_generation,
    pendingInputRequestId: run.pending_input_request_id,
    startedAt: run.started_at,
    heartbeatAt: run.heartbeat_at,
    endedAt: run.ended_at,
    exitCode: run.exit_code,
    processState: run.process_state ? JSON.parse(run.process_state) : null,
    cancelRequestedAt: run.cancel_requested_at ?? null,
    deadlineAt: effectiveDeadline(run),
    timeoutRequestedAt: run.timeout_requested_at ?? null,
  };
}

export function listActiveRuns(db: Database): RunStatusRecord[] {
  const rows = db
    .query(`SELECT ${RUN_COLUMNS} FROM runs WHERE status IN ('running', 'hitl')`)
    .all() as RunRow[];
  return rows.map(rowToRunStatusRecord);
}

export function getTaskAgentProvider(db: Database, taskId: string): string {
  const row = db.query('SELECT agent_provider FROM tasks WHERE id = ?').get(taskId) as {
    agent_provider: string;
  } | null;
  if (!row) {
    throw new DomainError('NOT_FOUND', `task not found: ${taskId}`);
  }
  return row.agent_provider;
}

export function requireRepositoryForTask(db: Database, task: TaskRecord): Repository {
  const repository = getRepositoryById(db, task.repoId);
  if (!repository) {
    throw new DomainError('NOT_FOUND', `repository not found: ${task.repoId}`);
  }
  return repository;
}

export function assertFencingMatches(run: RunRow, ownerId: string, generation: number): void {
  if (run.owner_token !== ownerId || run.lock_generation !== generation) {
    throw new DomainError(
      'STALE_GENERATION',
      `owner/generation mismatch for run ${run.id}: expected owner=${run.owner_token} ` +
        `generation=${run.lock_generation}`,
    );
  }
}

export {
  type AdmitResult,
  claimTask,
  admitNextEligibleTask,
  listRunnableTasks,
} from './admission.ts';

export { type ChildTaskSummary, type TaskContext, getTaskContext } from './context.ts';

export { clearQuarantine, finalizeRun, heartbeat, markUncertain } from './recovery.ts';

export interface RunStatusRecord {
  runId: string;
  taskId: string;
  provider: string;
  status: RunStatus;
  ownerId: string;
  generation: number;
  pendingInputRequestId: string | null;
  startedAt: string;
  heartbeatAt: string;
  endedAt: string | null;
  exitCode: number | null;
  processState: unknown;
  cancelRequestedAt?: string | null;
  deadlineAt: string;
  timeoutRequestedAt?: string | null;
}

export function getRunStatus(db: Database, runId: string): RunStatusRecord {
  const run = requireRun(db, runId);
  return {
    runId: run.id,
    taskId: run.task_id,
    provider: run.provider,
    cancelRequestedAt: run.cancel_requested_at ?? null,
    deadlineAt: effectiveDeadline(run),
    timeoutRequestedAt: run.timeout_requested_at ?? null,
    status: run.status,
    ownerId: run.owner_token,
    generation: run.lock_generation,
    pendingInputRequestId: run.pending_input_request_id,
    startedAt: run.started_at,
    heartbeatAt: run.heartbeat_at,
    endedAt: run.ended_at,
    exitCode: run.exit_code,
    processState: run.process_state ? JSON.parse(run.process_state) : null,
  };
}
