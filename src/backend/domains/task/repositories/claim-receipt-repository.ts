// Claim receipt database access (SPECIFICATION.md §2, LC-05a).
import type { Database } from 'bun:sqlite';

export interface ClaimReceiptRow {
  owner_id: string;
  idempotency_key: string;
  task_id: string;
  run_id: string;
  generation: number;
  created_at: string;
}

export function getClaimReceipt(
  db: Database,
  ownerId: string,
  idempotencyKey: string,
): ClaimReceiptRow | null {
  return db
    .query(
      `SELECT owner_id, idempotency_key, task_id, run_id, generation, created_at
       FROM claim_receipts
       WHERE owner_id = ? AND idempotency_key = ?`,
    )
    .get(ownerId, idempotencyKey) as ClaimReceiptRow | null;
}

export function insertClaimReceipt(
  db: Database,
  receipt: {
    ownerId: string;
    idempotencyKey: string;
    taskId: string;
    runId: string;
    generation: number;
    createdAt: string;
  },
): void {
  db.query(
    `INSERT INTO claim_receipts (owner_id, idempotency_key, task_id, run_id, generation, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.ownerId,
    receipt.idempotencyKey,
    receipt.taskId,
    receipt.runId,
    receipt.generation,
    receipt.createdAt,
  );
}
