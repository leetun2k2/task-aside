import type { Database } from 'bun:sqlite';
// Dedicated task admission and ownership logic (RF-40).
// Handles candidate selection, capacity limits, atomic claims, and generation fencing.
import { randomUUID } from 'node:crypto';
import { TASK_TIMEOUT_MS } from '../../../contracts/pool.ts';
import type {
  AdmitSkipReason,
  ClaimTaskRequest,
  ClaimTaskResponse,
} from '../../../contracts/run.ts';
import { DomainError } from '../../errors.ts';
import { eventHub } from '../../events/hub.ts';
import {
  ACTIVE_RUN_STATUSES,
  LEASE_DURATION_MS,
  countActiveRuns,
  effectiveDeadline,
  getClaimReceipt,
  getEffectiveMaxConcurrency,
  getLockByKey,
  getRunById,
  getTaskAgentProvider,
  requireRepositoryForTask,
  requireRun,
  requireTask,
} from './runs.ts';
import {
  TASK_COLUMNS,
  type TaskRecord,
  type TaskRow,
  reconcileBlockedParents,
  rowToTask,
} from './tasks.ts';

export type AdmitResult =
  (ClaimTaskResponse & { admitted: true }) | { admitted: false; reason: AdmitSkipReason };

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
 * Claims a specific, already-known-eligible task.
 * Atomic read-decide-write sequence inside an immediate-mode SQLite transaction.
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

/**
 * Atomic bulk admission: picks the single best eligible task via a short indexed query.
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
       ORDER BY enqueued_at ASC`,
    )
    .all() as TaskRow[];

  return rows.map(rowToTask).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}
