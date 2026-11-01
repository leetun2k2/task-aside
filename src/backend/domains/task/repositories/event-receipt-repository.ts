// Event receipt database access (SPECIFICATION.md §3, §7, TASKS.md T13, LC-04d).
import type { Database } from 'bun:sqlite';

export interface EventReceiptRow {
  event_hash: string;
}

export function findEventReceipt(
  db: Database,
  runId: string,
  sequence: number,
): EventReceiptRow | null {
  return db
    .query('SELECT event_hash FROM run_event_receipts WHERE run_id = ? AND sequence = ?')
    .get(runId, sequence) as EventReceiptRow | null;
}

export function insertEventReceipt(
  db: Database,
  runId: string,
  sequence: number,
  hash: string,
  now: string,
): void {
  db.query(
    `INSERT INTO run_event_receipts (run_id, sequence, event_hash, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(runId, sequence, hash, now);
}
