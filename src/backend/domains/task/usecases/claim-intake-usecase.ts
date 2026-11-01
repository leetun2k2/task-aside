// Claim an Intake attempt (specs/2026-10-25-message-intake/01-contracts-and-
// lifecycle.md "Intake attempt: Atomic claim creates a run with purpose
// 'intake', independent task ownership/fencing and one global slot, without
// repo locks."). Mirrors claim-task-usecase.ts's fencing/idempotency shape
// but never touches run_locks — an Intake attempt does not edit any
// registered repository, so there is no working tree to exclude other
// writers from.
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { INTAKE_DEADLINE_MS } from '../../../../contracts/intake.ts';
import type { ClaimTaskRequest, ClaimTaskResponse } from '../../../../contracts/run.ts';
import { DomainError } from '../../../errors.ts';
import { eventHub } from '../../../events/hub.ts';
import { getClaimReceipt, insertClaimReceipt } from '../repositories/claim-receipt-repository.ts';
import { countActiveRuns, insertRunRecord, requireRun } from '../repositories/run-repository.ts';
import { markTaskProcessing } from '../repositories/task-write-repository.ts';
import {
  getEffectiveMaxConcurrency as getDbEffectiveMaxConcurrency,
  requireTask,
} from '../runs.ts';
import {
  assertCapacityAvailable,
  buildClaimResponse,
  validateClaimReceiptTask,
} from '../services/admission-service.ts';

export function assertIntakeClaimable(stage: string, status: string): void {
  if (stage !== 'intake') {
    throw new DomainError('INVALID_TRANSITION', 'task is not awaiting an Intake attempt');
  }
  if (status === 'processing') {
    throw new DomainError('LOCK_HELD', 'task is already being processed');
  }
  if (status !== 'todo') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `cannot claim task in status '${status}'; only 'todo' tasks may be claimed`,
    );
  }
}

export function claimIntakeUsecase(
  db: Database,
  taskId: string,
  request: ClaimTaskRequest,
): ClaimTaskResponse {
  const existingReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
  if (existingReceipt) {
    validateClaimReceiptTask(existingReceipt.task_id, taskId, request.ownerId);
    const existingRun = requireRun(db, existingReceipt.run_id);
    const existingTask = requireTask(db, taskId);
    return buildClaimResponse(
      existingRun,
      existingTask,
      undefined,
      existingRun.deadline_at ?? new Date().toISOString(),
      { writeRoots: [], lockGenerations: {} },
    );
  }

  const runId = `run_${randomUUID()}`;
  const now = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + INTAKE_DEADLINE_MS).toISOString();

  const defaultProviderRow = db
    .query('SELECT default_provider FROM settings WHERE id = 1')
    .get() as { default_provider: string } | null;
  const provider = defaultProviderRow?.default_provider ?? 'claude';

  let claimedRunGeneration = 1;

  const applyAtomically = db.transaction(() => {
    // Re-verify receipt inside transaction
    const insideReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
    if (insideReceipt) {
      validateClaimReceiptTask(insideReceipt.task_id, taskId, request.ownerId);
      const existingRun = requireRun(db, insideReceipt.run_id);
      const existingTask = requireTask(db, taskId);
      return buildClaimResponse(
        existingRun,
        existingTask,
        undefined,
        existingRun.deadline_at ?? new Date().toISOString(),
        { writeRoots: [], lockGenerations: {} },
      );
    }

    const task = requireTask(db, taskId);
    assertIntakeClaimable(task.stage ?? 'ready', task.status);

    const activeCount = countActiveRuns(db);
    const effectiveCap = getDbEffectiveMaxConcurrency(db);
    assertCapacityAvailable(activeCount, effectiveCap);

    claimedRunGeneration = request.generation > 0 ? request.generation : 1;

    insertRunRecord(db, {
      id: runId,
      taskId,
      provider,
      ownerToken: request.ownerId,
      lockGeneration: claimedRunGeneration,
      startedAt: now,
      deadlineAt,
      purpose: 'intake',
      admittedScope: [],
      inputRevision: task.intakeRevision ?? 0,
      policyHash: null,
    });
    markTaskProcessing(db, taskId, now);
    insertClaimReceipt(db, {
      ownerId: request.ownerId,
      idempotencyKey: request.idempotencyKey,
      taskId,
      runId,
      generation: claimedRunGeneration,
      createdAt: now,
    });
    return null;
  });

  const replayed = applyAtomically.immediate();
  if (replayed) {
    return replayed;
  }

  const updatedTask = requireTask(db, taskId);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId,
      status: 'processing',
      previousStatus: 'todo',
      version: updatedTask.version,
      blockedReason: updatedTask.blockedReason,
      updatedAt: now,
    },
  });
  eventHub.publish({
    type: 'run.changed',
    data: { runId, taskId, status: 'running', startedAt: now },
  });

  const createdRun = requireRun(db, runId);
  return buildClaimResponse(createdRun, updatedTask, undefined, deadlineAt, {
    writeRoots: [],
    lockGenerations: {},
  });
}
