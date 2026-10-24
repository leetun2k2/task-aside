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
import { DomainError } from '../../api/errors.ts';
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

const LEASE_DURATION_MS = 30_000;
const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['running', 'hitl']);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['done', 'error', 'cancelled']);

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

interface ClaimReceiptRow {
  task_id: string;
  run_id: string;
  generation: number;
}

function getClaimReceipt(
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
  return run.deadline_at ?? new Date(new Date(run.started_at).getTime() + TASK_TIMEOUT_MS).toISOString();
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

const RUN_COLUMNS =
  `id, task_id, provider, status, owner_token, lock_generation, process_state,
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
    .get(runId) as { pending_yield_child_ids: string | null; pending_yield_reason: string | null } | null;
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
  const requested: PendingYieldIntent = { childTaskIds: intent.childTaskIds, reason: intent.reason };

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
    "UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ?",
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
    "UPDATE runs SET timeout_requested_at = COALESCE(timeout_requested_at, ?) WHERE id = ?",
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

function buildClaimResponse(db: Database, runId: string, task: TaskRecord): ClaimTaskResponse {
  const run = requireRun(db, runId);
  const repository = requireRepositoryForTask(db, task);
  const lock = getLockByKey(db, repository.canonicalPath);
  return {
    runId,
    generation: run.lock_generation,
    leaseExpiresAt: lock?.lease_expires_at ?? new Date().toISOString(),
    taskSnapshot: task,
    deadlineAt: effectiveDeadline(run),
    workingTreeKey: repository.canonicalPath,
  };
}

/**
 * Claims a specific, already-known-eligible task. The low-level primitive
 * every claim route (direct per-id claim and `admitNextEligibleTask` below)
 * routes through, so capacity/idempotency/fencing guards apply uniformly
 * (specs/2026-10-24-polling-worker-pool.md "Apply these guards to every claim
 * route"). Idempotency is durable (`claim_receipts`, survives backend
 * restart) and keyed by (ownerId, idempotencyKey) alone — repeating the same
 * key for the same task returns the original admission; reusing it for a
 * DIFFERENT task is a conflict, never a silent second attempt.
 *
 * Everything here runs synchronously with no `await` in the call stack; on a
 * single Bun process that single-threaded synchronicity is what makes the
 * read-decide-write sequence atomic with respect to other concurrent HTTP
 * handlers on the same backend. The actual mutations additionally run inside
 * an immediate-mode SQLite transaction (`.immediate()`) for correctness and
 * to match the "BEGIN IMMEDIATE" semantics the spec names explicitly.
 */
export function claimTask(
  db: Database,
  taskId: string,
  request: ClaimTaskRequest,
): ClaimTaskResponse {
  const existingReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
  if (existingReceipt) {
    if (existingReceipt.task_id !== taskId) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `idempotency key already used by owner ${request.ownerId} for a different task ` +
          `(${existingReceipt.task_id}); reusing it for ${taskId} conflicts`,
      );
    }
    return buildClaimResponse(db, existingReceipt.run_id, requireTask(db, taskId));
  }

  const task = requireTask(db, taskId);

  if (task.status === 'processing') {
    throw new DomainError('LOCK_HELD', `task ${taskId} is already being processed`);
  }

  if (task.status !== 'todo') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `cannot claim task in status '${task.status}'; only 'todo' tasks may be claimed`,
    );
  }

  const activeCount = countActiveRuns(db);
  const effectiveCap = getEffectiveMaxConcurrency(db);
  if (activeCount >= effectiveCap) {
    throw new DomainError(
      'CAPACITY_EXCEEDED',
      `at capacity: ${activeCount}/${effectiveCap} active runs across the shared backend`,
    );
  }

  const repository = requireRepositoryForTask(db, task);
  const workingTreeKey = repository.canonicalPath;
  const lock = getLockByKey(db, workingTreeKey);

  let newGeneration: number;
  if (lock) {
    if (lock.quarantined === 1) {
      throw new DomainError('LOCK_HELD', `working tree is quarantined: ${workingTreeKey}`);
    }

    const ownerRun = lock.owner_run_id ? getRunById(db, lock.owner_run_id) : null;
    if (ownerRun && ACTIVE_RUN_STATUSES.has(ownerRun.status)) {
      throw new DomainError(
        'LOCK_HELD',
        `working tree lock is currently held by run ${ownerRun.id}`,
      );
    }

    if (request.generation > 0 && request.generation !== lock.generation) {
      throw new DomainError(
        'STALE_GENERATION',
        `stale generation: expected ${lock.generation}, got ${request.generation}`,
      );
    }
    newGeneration = lock.generation + 1;
  } else {
    newGeneration = 1;
  }

  const runId = `run_${randomUUID()}`;
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  const deadlineAt = new Date(Date.now() + TASK_TIMEOUT_MS).toISOString();
  const provider = getTaskAgentProvider(db, taskId);

  const applyAtomically = db.transaction(() => {
    db.query(
      `INSERT INTO run_locks
        (working_tree_key, owner_run_id, generation, lease_expires_at, quarantined,
         quarantined_reason, quarantined_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)
       ON CONFLICT(working_tree_key) DO UPDATE SET
         owner_run_id = excluded.owner_run_id,
         generation = excluded.generation,
         lease_expires_at = excluded.lease_expires_at,
         quarantined = 0,
         quarantined_reason = NULL,
         quarantined_at = NULL,
         updated_at = excluded.updated_at`,
    ).run(workingTreeKey, runId, newGeneration, leaseExpiresAt, now);

    db.query(
      `INSERT INTO runs
        (id, task_id, provider, provider_session_id, status, owner_token, lock_generation,
         process_state, pending_input_request_id, log_path, started_at, heartbeat_at, ended_at,
         exit_code, deadline_at)
       VALUES (?, ?, ?, NULL, 'running', ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`,
    ).run(runId, taskId, provider, request.ownerId, newGeneration, now, now, deadlineAt);

    db.query(
      "UPDATE tasks SET status = 'processing', updated_at = ?, version = version + 1 WHERE id = ?",
    ).run(now, taskId);

    db.query(
      `INSERT INTO claim_receipts (owner_id, idempotency_key, task_id, run_id, generation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(request.ownerId, request.idempotencyKey, taskId, runId, newGeneration, now);
  });
  applyAtomically.immediate();

  const updatedTask = requireTask(db, taskId);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId,
      status: 'processing',
      previousStatus: task.status,
      version: updatedTask.version,
      blockedReason: updatedTask.blockedReason,
      updatedAt: now,
    },
  });
  eventHub.publish({
    type: 'run.changed',
    data: {
      runId,
      taskId,
      status: 'running',
      startedAt: now,
    },
  });

  return {
    runId,
    generation: newGeneration,
    leaseExpiresAt,
    taskSnapshot: updatedTask,
    deadlineAt,
    workingTreeKey,
  };
}

export type AdmitResult =
  | (ClaimTaskResponse & { admitted: true })
  | { admitted: false; reason: AdmitSkipReason };

/**
 * Atomic bulk admission: picks the single best eligible task itself via a
 * short indexed query (no full-backlog fetch into the engine), then reuses
 * `claimTask`'s capacity/fencing/idempotency guards unchanged. Empty polls
 * (capacity full, nothing eligible) never write a receipt — "no work means no
 * reservation was committed", so retrying the same key can admit work later.
 */
export function admitNextEligibleTask(
  db: Database,
  request: { ownerId: string; idempotencyKey: string },
): AdmitResult {
  const existingReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
  if (existingReceipt) {
    const task = requireTask(db, existingReceipt.task_id);
    return { admitted: true, ...buildClaimResponse(db, existingReceipt.run_id, task) };
  }

  reconcileBlockedParents(db);

  const activeCount = countActiveRuns(db);
  const effectiveCap = getEffectiveMaxConcurrency(db);
  if (activeCount >= effectiveCap) {
    return { admitted: false, reason: 'concurrency_limit_reached' };
  }

  const eligible = db
    .query(
      `SELECT t.id FROM tasks t
       JOIN repositories r ON r.id = t.repository_id
       LEFT JOIN run_locks rl ON rl.working_tree_key = r.canonical_path
       LEFT JOIN runs owner_run ON owner_run.id = rl.owner_run_id
       WHERE t.status = 'todo' AND t.block_kind IS NULL
         AND (rl.working_tree_key IS NULL OR (
           rl.quarantined = 0 AND (
             rl.owner_run_id = '' OR owner_run.status NOT IN ('running', 'hitl')
           )
         ))
       ORDER BY t.priority ASC, t.enqueued_at ASC, t.id ASC
       LIMIT 1`,
    )
    .get() as { id: string } | null;

  if (!eligible) {
    const anyRunnable = db
      .query("SELECT COUNT(*) as count FROM tasks WHERE status = 'todo' AND block_kind IS NULL")
      .get() as { count: number };
    return {
      admitted: false,
      reason: anyRunnable.count > 0 ? 'all_trees_busy' : 'no_runnable_tasks',
    };
  }

  const claimed = claimTask(db, eligible.id, {
    ownerId: request.ownerId,
    generation: 0,
    idempotencyKey: request.idempotencyKey,
  });
  return { admitted: true, ...claimed };
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function listRunnableTasks(db: Database): TaskRecord[] {
  reconcileBlockedParents(db);

  const rows = db
    .query(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE status = 'todo' AND block_kind IS NULL
       ORDER BY priority ASC, enqueued_at ASC`,
    )
    .all() as TaskRow[];
  return rows.map(rowToTask).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

export interface ChildTaskSummary {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  errorMessage: string | null;
}

export interface TaskContext {
  task: TaskRecord;
  repository: Repository;
  parent: TaskRecord | null;
  conversation: { id: string; createdAt: string; updatedAt: string } | null;
  messages: Message[];
  children?: ChildTaskSummary[];
}

export function getTaskContext(db: Database, taskId: string): TaskContext {
  const task = requireTask(db, taskId);
  const repository = requireRepositoryForTask(db, task);
  const parent = task.parentId ? getTaskById(db, task.parentId) : null;

  const conversationRow = db
    .query('SELECT id, created_at, updated_at FROM conversations WHERE id = ?')
    .get(task.conversationId) as { id: string; created_at: string; updated_at: string } | null;

  const { messages } = listMessages(db, task.conversationId, { limit: 200 });

  // Query child tasks if any
  const childRows = db
    .query(
      'SELECT id, title, status, blocked_reason FROM tasks WHERE parent_id = ? ORDER BY created_at ASC',
    )
    .all(taskId) as { id: string; title: string; status: string; blocked_reason: string | null }[];

  const children: ChildTaskSummary[] = childRows.map((child) => {
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

  return {
    task,
    repository,
    parent,
    conversation: conversationRow
      ? {
          id: conversationRow.id,
          createdAt: conversationRow.created_at,
          updatedAt: conversationRow.updated_at,
        }
      : null,
    messages,
    children: children.length > 0 ? children : undefined,
  };
}

export function heartbeat(db: Database, runId: string, request: HeartbeatRequest): { ok: true } {
  const run = requireRun(db, runId);
  assertFencingMatches(run, request.ownerId, request.generation);

  const lock = getLockForRun(db, runId);
  if (!lock || lock.generation !== request.generation) {
    throw new DomainError('STALE_GENERATION', `lock generation mismatch for run ${runId}`);
  }

  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  const applyAtomically = db.transaction(() => {
    db.query('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(now, runId);
    db.query(
      'UPDATE run_locks SET lease_expires_at = ?, updated_at = ? WHERE working_tree_key = ?',
    ).run(leaseExpiresAt, now, lock.working_tree_key);
  });
  applyAtomically();

  return { ok: true };
}

export function finalizeRun(
  db: Database,
  runId: string,
  request: FinalizeRunRequest,
): { ok: true } {
  const run = requireRun(db, runId);
  assertFencingMatches(run, request.ownerId, request.generation);

  // Idempotency guard: a run already finalized to a terminal status must not
  // be re-finalized (e.g. a cancel-watcher and the normal dispatch stream
  // racing to finalize the same run). Returning early here also protects
  // against double lock-release / double child-reconciliation.
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return { ok: true };
  }

  if (TERMINAL_RUN_STATUSES.has(request.status)) {
    if (!request.verifiedStopped || !request.verificationMethod) {
      throw new DomainError(
        'VERIFIED_STOP_REQUIRED',
        'terminal finalize requires verifiedStopped:true and a verificationMethod',
      );
    }
  }

  const now = new Date().toISOString();
  const processState = JSON.stringify({
    status: request.status,
    verifiedStoppedAt: now,
    verificationMethod: request.verificationMethod ?? null,
    exitCode: request.status === 'done' ? 0 : 1,
    summary: request.summary ?? null,
    errorCode: request.errorCode ?? null,
    errorMessage: request.errorMessage ?? null,
  });
  const lock = getLockForRun(db, runId);
  // Timeout reason stays visible distinctly from an ordinary agent failure.
  const blockedReason =
    request.status === 'error'
      ? request.errorCode === 'TIMEOUT'
        ? (request.errorMessage ?? 'Task exceeded the execution deadline')
        : (request.errorMessage ?? request.summary ?? 'Run failed')
      : null;

  // A yield request is intent, never proof of process exit. Only now — after
  // trusted adapter stop evidence (verifiedStopped/verificationMethod above)
  // — may the backend release the lock and block the parent on children,
  // using ONLY the durably-recorded intent (never anything client-supplied
  // at yield time). This applies regardless of the reported terminal status:
  // the agent already requested the handoff and then exited.
  const pendingYield = getPendingYield(db, runId);

  const applyAtomically = db.transaction(() => {
    db.query('UPDATE runs SET status = ?, ended_at = ?, process_state = ? WHERE id = ?').run(
      request.status,
      now,
      processState,
      runId,
    );

    if (pendingYield) {
      db.query(
        `UPDATE tasks
         SET status = 'todo', block_kind = 'children', blocked_reason = ?,
             blocked_on_child_ids = ?, updated_at = ?, version = version + 1
         WHERE id = ?`,
      ).run(
        pendingYield.reason ?? 'Waiting for child tasks',
        JSON.stringify(pendingYield.childTaskIds),
        now,
        run.task_id,
      );
    } else if (request.status === 'error') {
      db.query(
        'UPDATE tasks SET status = ?, blocked_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      ).run(request.status, blockedReason, now, run.task_id);
    } else {
      db.query(
        'UPDATE tasks SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      ).run(request.status, now, run.task_id);
    }

    if (lock) {
      // Release ownership but never touch `generation` — generations must
      // never reset after release (SPECIFICATION.md §5, T12 acceptance).
      db.query(
        'UPDATE run_locks SET owner_run_id = ?, updated_at = ? WHERE working_tree_key = ?',
      ).run('', now, lock.working_tree_key);
    }
  });
  applyAtomically();

  const updatedTask = getTaskById(db, run.task_id);
  eventHub.publish({
    type: 'run.changed',
    data: {
      runId,
      taskId: run.task_id,
      status: request.status,
      endedAt: now,
      exitCode: null,
    },
  });
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: run.task_id,
      status: pendingYield ? 'todo' : request.status,
      version: updatedTask?.version ?? 1,
      blockedReason: pendingYield ? (pendingYield.reason ?? 'Waiting for child tasks') : blockedReason,
      updatedAt: now,
    },
  });

  // Reconcile any parent tasks waiting on this task
  reconcileBlockedParents(db);

  return { ok: true };
}

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

export function markUncertain(
  db: Database,
  runId: string,
  request: MarkUncertainRequest,
): { ok: true } {
  const run = requireRun(db, runId);
  assertFencingMatches(run, request.ownerId, request.generation);

  const lock = getLockForRun(db, runId);
  const now = new Date().toISOString();

  const applyAtomically = db.transaction(() => {
    db.query("UPDATE runs SET status = 'uncertain' WHERE id = ?").run(runId);
    if (lock) {
      db.query(
        `UPDATE run_locks
         SET quarantined = 1, quarantined_reason = ?, quarantined_at = ?, updated_at = ?
         WHERE working_tree_key = ?`,
      ).run(request.reason, now, now, lock.working_tree_key);
    }
  });
  applyAtomically();

  eventHub.publish({
    type: 'run.changed',
    data: { runId, taskId: run.task_id, status: 'uncertain' },
  });

  return { ok: true };
}

export function clearQuarantine(
  db: Database,
  runId: string,
  _request: ClearQuarantineRequest,
): { ok: true } {
  const run = requireRun(db, runId);
  const lock = getLockForRun(db, runId);
  const now = new Date().toISOString();

  const applyAtomically = db.transaction(() => {
    if (lock) {
      db.query(
        `UPDATE run_locks
         SET quarantined = 0, quarantined_reason = NULL, quarantined_at = NULL, owner_run_id = '', updated_at = ?
         WHERE working_tree_key = ?`,
      ).run(now, lock.working_tree_key);
    }
    db.query("UPDATE runs SET status = 'cancelled' WHERE id = ? AND status = 'uncertain'").run(
      runId,
    );
    db.query(
      "UPDATE tasks SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ?",
    ).run(now, run.task_id);
  });
  applyAtomically();

  const updatedTask = getTaskById(db, run.task_id);
  eventHub.publish({
    type: 'run.changed',
    data: { runId, taskId: run.task_id, status: 'cancelled' },
  });
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: run.task_id,
      status: 'cancelled',
      version: updatedTask?.version ?? 1,
      updatedAt: now,
    },
  });

  return { ok: true };
}
