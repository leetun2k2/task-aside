// Run finalization, verified stop enforcement, and recovery paths (RF-41).
import type { Database } from 'bun:sqlite';
import type {
  ClearQuarantineRequest,
  FinalizeRunRequest,
  HeartbeatRequest,
  MarkUncertainRequest,
} from '../../../contracts/run.ts';
import { DomainError } from '../../errors.ts';
import { eventHub } from '../../events/hub.ts';
import {
  TERMINAL_RUN_STATUSES,
  assertFencingMatches,
  getLockForRun,
  getPendingYield,
  requireRun,
} from './runs.ts';
import { getTaskById, reconcileBlockedParents } from './tasks.ts';
import { heartbeatUsecase } from './usecases/heartbeat-usecase.ts';

// Forwarding export (LC-05b): logic moved to heartbeat-usecase.ts; kept here
// so existing callers of recovery.ts/runs.ts don't need to change.
export function heartbeat(db: Database, runId: string, request: HeartbeatRequest): { ok: true } {
  return heartbeatUsecase(db, runId, request);
}

export function finalizeRun(
  db: Database,
  runId: string,
  request: FinalizeRunRequest,
): { ok: true } {
  const run = requireRun(db, runId);
  assertFencingMatches(run, request.ownerId, request.generation);

  if (run.purpose === 'intake' && request.status === 'done') {
    throw new DomainError(
      'INVALID_TRANSITION',
      'Intake runs cannot be finalized via generic finalize as done; use commitIntakeResult or failIntake',
    );
  }

  // Idempotency guard: a run already finalized to a terminal status must not
  // be re-finalized.
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
  const blockedReason =
    request.status === 'error'
      ? request.errorCode === 'TIMEOUT'
        ? (request.errorMessage ?? 'Task exceeded the execution deadline')
        : (request.errorMessage ?? request.summary ?? 'Run failed')
      : null;

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

    // Release ownership on all locks held by this run, never resetting generation
    db.query("UPDATE run_locks SET owner_run_id = '', updated_at = ? WHERE owner_run_id = ?").run(
      now,
      runId,
    );
    if (lock) {
      db.query(
        "UPDATE run_locks SET owner_run_id = '', updated_at = ? WHERE working_tree_key = ?",
      ).run(now, lock.working_tree_key);
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
      blockedReason: pendingYield
        ? (pendingYield.reason ?? 'Waiting for child tasks')
        : blockedReason,
      updatedAt: now,
    },
  });

  // Reconcile any parent tasks waiting on this task
  reconcileBlockedParents(db);

  return { ok: true };
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
    db.query(
      `UPDATE run_locks
       SET quarantined = 1, quarantined_reason = ?, quarantined_at = ?, updated_at = ?
       WHERE owner_run_id = ?`,
    ).run(request.reason, now, now, runId);
    if (lock) {
      db.query(
        `UPDATE run_locks
         SET quarantined = 1, quarantined_reason = ?, quarantined_at = ?, updated_at = ?
         WHERE working_tree_key = ?`,
      ).run(request.reason, now, now, lock.working_tree_key);
    }
    if (run.admitted_scope) {
      try {
        const paths = JSON.parse(run.admitted_scope) as string[];
        for (const p of paths) {
          db.query(
            `UPDATE run_locks
             SET quarantined = 1, quarantined_reason = ?, quarantined_at = ?, updated_at = ?
             WHERE working_tree_key = ?`,
          ).run(request.reason, now, now, p);
        }
      } catch {}
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
    db.query(
      `UPDATE run_locks
       SET quarantined = 0, quarantined_reason = NULL, quarantined_at = NULL, owner_run_id = '', updated_at = ?
       WHERE owner_run_id = ?`,
    ).run(now, runId);
    if (lock && (lock.owner_run_id === runId || lock.owner_run_id === '')) {
      db.query(
        `UPDATE run_locks
         SET quarantined = 0, quarantined_reason = NULL, quarantined_at = NULL, owner_run_id = '', updated_at = ?
         WHERE working_tree_key = ? AND (owner_run_id = ? OR owner_run_id = '')`,
      ).run(now, lock.working_tree_key, runId);
    }
    if (run.admitted_scope) {
      try {
        const paths = JSON.parse(run.admitted_scope) as string[];
        for (const p of paths) {
          db.query(
            `UPDATE run_locks
             SET quarantined = 0, quarantined_reason = NULL, quarantined_at = NULL, owner_run_id = '', updated_at = ?
             WHERE working_tree_key = ? AND (owner_run_id = ? OR owner_run_id = '')`,
          ).run(now, p, runId);
        }
      } catch {}
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
