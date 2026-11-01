// Working tree lock database access (SPECIFICATION.md §2, LC-05a).
import type { Database } from 'bun:sqlite';

export interface RunLockRow {
  working_tree_key: string;
  owner_run_id: string;
  generation: number;
  lease_expires_at: string;
  quarantined: number;
  quarantined_reason?: string | null;
  quarantined_at?: string | null;
}

export function getLockByKey(db: Database, workingTreeKey: string): RunLockRow | null {
  return db
    .query(
      `SELECT working_tree_key, owner_run_id, generation, lease_expires_at, quarantined,
              quarantined_reason, quarantined_at
       FROM run_locks WHERE working_tree_key = ?`,
    )
    .get(workingTreeKey) as RunLockRow | null;
}

export function getLockForRun(db: Database, runId: string): RunLockRow | null {
  return db
    .query(
      `SELECT working_tree_key, owner_run_id, generation, lease_expires_at, quarantined,
              quarantined_reason, quarantined_at
       FROM run_locks WHERE owner_run_id = ?`,
    )
    .get(runId) as RunLockRow | null;
}

export function getLocksForRun(db: Database, runId: string): RunLockRow[] {
  return db
    .query(
      `SELECT working_tree_key, owner_run_id, generation, lease_expires_at, quarantined,
              quarantined_reason, quarantined_at
       FROM run_locks WHERE owner_run_id = ?`,
    )
    .all(runId) as RunLockRow[];
}

export function refreshLockLeasesForRun(
  db: Database,
  runId: string,
  leaseExpiresAt: string,
  now: string,
): void {
  db.query(
    'UPDATE run_locks SET lease_expires_at = ?, updated_at = ? WHERE owner_run_id = ?',
  ).run(leaseExpiresAt, now, runId);
}

export function upsertClaimLock(
  db: Database,
  workingTreeKey: string,
  runId: string,
  generation: number,
  leaseExpiresAt: string,
  now: string,
): void {
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
  ).run(workingTreeKey, runId, generation, leaseExpiresAt, now);
}
