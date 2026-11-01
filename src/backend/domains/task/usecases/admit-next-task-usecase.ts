// Admit next eligible task usecase (SPECIFICATION.md §2, TASKS.md T11, LC-05a).
import type { Database } from 'bun:sqlite';
import type { AdmitSkipReason, ClaimTaskResponse } from '../../../../contracts/run.ts';
import { getClaimReceipt } from '../repositories/claim-receipt-repository.ts';
import { getLockByKey } from '../repositories/lock-repository.ts';
import { countActiveRuns, requireRun } from '../repositories/run-repository.ts';
import {
  countRunnableTasks,
  findNextEligibleTaskId,
} from '../repositories/task-admission-repository.ts';
import {
  getEffectiveMaxConcurrency as getDbEffectiveMaxConcurrency,
  requireRepositoryForTask,
  requireTask,
} from '../runs.ts';
import { buildClaimResponse } from '../services/admission-service.ts';
import { reconcileBlockedParents } from '../tasks.ts';
import { claimTaskUsecase } from './claim-task-usecase.ts';

export type AdmitResult =
  (ClaimTaskResponse & { admitted: true }) | { admitted: false; reason: AdmitSkipReason };

export function admitNextTaskUsecase(
  db: Database,
  request: { ownerId: string; idempotencyKey: string },
): AdmitResult {
  const existingReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
  if (existingReceipt) {
    const run = requireRun(db, existingReceipt.run_id);
    const task = requireTask(db, existingReceipt.task_id);
    if (run.purpose === 'intake') {
      return {
        admitted: true,
        ...buildClaimResponse(run, task, undefined, run.deadline_at ?? new Date().toISOString(), {
          writeRoots: [],
          lockGenerations: {},
        }),
      };
    }
    const repository = requireRepositoryForTask(db, task);
    const lock = getLockByKey(db, repository.canonicalPath);
    return {
      admitted: true,
      ...buildClaimResponse(
        run,
        task,
        repository.canonicalPath,
        lock?.lease_expires_at ?? new Date().toISOString(),
      ),
    };
  }

  reconcileBlockedParents(db);

  let result: AdmitResult | null = null;
  const applyAtomically = db.transaction(() => {
    // Re-verify receipt inside transaction
    const insideReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
    if (insideReceipt) {
      const run = requireRun(db, insideReceipt.run_id);
      const task = requireTask(db, insideReceipt.task_id);
      if (run.purpose === 'intake') {
        result = {
          admitted: true,
          ...buildClaimResponse(run, task, undefined, run.deadline_at ?? new Date().toISOString(), {
            writeRoots: [],
            lockGenerations: {},
          }),
        };
        return;
      }
      const repository = requireRepositoryForTask(db, task);
      const lock = getLockByKey(db, repository.canonicalPath);
      result = {
        admitted: true,
        ...buildClaimResponse(
          run,
          task,
          repository.canonicalPath,
          lock?.lease_expires_at ?? new Date().toISOString(),
        ),
      };
      return;
    }

    const activeCount = countActiveRuns(db);
    const effectiveCap = getDbEffectiveMaxConcurrency(db);
    if (activeCount >= effectiveCap) {
      result = { admitted: false, reason: 'concurrency_limit_reached' };
      return;
    }

    const eligibleId = findNextEligibleTaskId(db);
    if (!eligibleId) {
      const runnableCount = countRunnableTasks(db);
      result = {
        admitted: false,
        reason: runnableCount > 0 ? 'all_trees_busy' : 'no_runnable_tasks',
      };
      return;
    }

    const claimed = claimTaskUsecase(db, eligibleId, {
      ownerId: request.ownerId,
      generation: 0,
      idempotencyKey: request.idempotencyKey,
    });
    result = { admitted: true, ...claimed };
  });

  applyAtomically.immediate();
  if (!result) {
    throw new Error('admitNextTaskUsecase failed to produce a result');
  }
  return result;
}
