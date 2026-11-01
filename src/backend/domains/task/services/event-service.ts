// Event ingestion domain service and rules (SPECIFICATION.md §3, §7, LC-04d).
import type { EventEnvelope } from '../../../../contracts/event.ts';
import { DomainError } from '../../../errors.ts';
import type { EventReceiptRow } from '../repositories/event-receipt-repository.ts';

export function validateEventRunId(event: EventEnvelope, expectedRunId: string): void {
  if (event.runId !== expectedRunId) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `event runId mismatch: expected ${expectedRunId}, got ${event.runId}`,
    );
  }
}

export function evaluateReceiptAction(
  existingReceipt: EventReceiptRow | null,
  eventHash: string,
  sequence: number,
): 'idempotent-skip' | 'persist' {
  if (existingReceipt) {
    if (existingReceipt.event_hash !== eventHash) {
      throw new DomainError(
        'SEQUENCE_CONFLICT',
        `sequence ${sequence} already recorded with a different payload`,
      );
    }
    return 'idempotent-skip';
  }
  return 'persist';
}
