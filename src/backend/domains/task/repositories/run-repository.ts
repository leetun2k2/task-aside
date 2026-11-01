// Run database access (SPECIFICATION.md §2, TASKS.md T11, LC-04b, LC-04c, LC-04d, LC-05a).
import type { Database } from 'bun:sqlite';
import type { RunStatus } from '../../../../contracts/run.ts';
import { DomainError } from '../../../errors.ts';

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
  cancel_requested_at: string | null;
  deadline_at: string | null;
  timeout_requested_at: string | null;
  purpose: 'intake' | 'implementation';
  admitted_scope: string | null;
  input_revision: number;
  policy_hash: string | null;
  terminal_outcome: string | null;
}

export const RUN_COLUMNS = `id, task_id, provider, status, owner_token, lock_generation, process_state,
   pending_input_request_id, started_at, heartbeat_at, ended_at, exit_code,
   cancel_requested_at, deadline_at, timeout_requested_at, purpose,
   admitted_scope, input_revision, policy_hash, terminal_outcome`;

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

// Counts `uncertain` runs too (specs/2026-10-25-message-intake/01-contracts-
// and-lifecycle.md "Admission counts unresolved attempts as occupied, not
// only 'running' and 'hitl' labels."): an uncertain run has not been proven
// stopped, so it must keep occupying a global slot — a prior bug here would
// let the pool over-admit past the configured/MAX_WORKERS cap whenever a
// stop could not be verified (see src/execution-engine/dispatcher.ts
// markUncertain paths), which is exactly the quarantine-but-still-occupied
// case the pool spec requires.
export function countActiveRuns(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM runs WHERE status IN ('running', 'hitl', 'uncertain')")
    .get() as { count: number };
  return row.count;
}

export function insertRunRecord(
  db: Database,
  run: {
    id: string;
    taskId: string;
    provider: string;
    ownerToken: string;
    lockGeneration: number;
    startedAt: string;
    deadlineAt: string;
    purpose?: 'intake' | 'implementation';
    admittedScope?: string[] | null;
    inputRevision?: number;
    policyHash?: string | null;
    terminalOutcome?: string | null;
  },
): void {
  db.query(
    `INSERT INTO runs
      (id, task_id, provider, provider_session_id, status, owner_token, lock_generation,
       process_state, pending_input_request_id, log_path, started_at, heartbeat_at, ended_at,
       exit_code, deadline_at, purpose, admitted_scope, input_revision, policy_hash, terminal_outcome)
     VALUES (?, ?, ?, NULL, 'running', ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.taskId,
    run.provider,
    run.ownerToken,
    run.lockGeneration,
    run.startedAt,
    run.startedAt,
    run.deadlineAt,
    run.purpose ?? 'implementation',
    run.admittedScope ? JSON.stringify(run.admittedScope) : null,
    run.inputRevision ?? 0,
    run.policyHash ?? null,
    run.terminalOutcome ?? null,
  );
}

export interface PendingHitlRunRow {
  id: string;
  status: string;
  pending_input_request_id: string;
  purpose: 'intake' | 'implementation';
}

export function findPendingHitlRun(db: Database, taskId: string): PendingHitlRunRow | null {
  return db
    .query(
      `SELECT id, status, pending_input_request_id, purpose
       FROM runs
       WHERE task_id = ? AND pending_input_request_id IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId) as PendingHitlRunRow | null;
}

export function resolvePendingHitlRun(db: Database, runId: string, now: string): void {
  db.query(
    `UPDATE runs
     SET pending_input_request_id = NULL, status = 'running', heartbeat_at = ?
     WHERE id = ?`,
  ).run(now, runId);
}

export function markRunHitl(db: Database, runId: string, requestId: string, now: string): void {
  db.query(
    `UPDATE runs
     SET status = 'hitl', pending_input_request_id = ?, heartbeat_at = ?
     WHERE id = ?`,
  ).run(requestId, now, runId);
}

export function refreshRunHeartbeat(db: Database, runId: string, now: string): void {
  db.query('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(now, runId);
}
