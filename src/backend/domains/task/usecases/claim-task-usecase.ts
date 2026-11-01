// Claim task usecase (SPECIFICATION.md §2, TASKS.md T11, LC-05a).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { TASK_TIMEOUT_MS } from '../../../../contracts/pool.ts';
import type { ClaimTaskRequest, ClaimTaskResponse } from '../../../../contracts/run.ts';
import type { Repository } from '../../../../contracts/task.ts';
import { DomainError } from '../../../errors.ts';
import { eventHub } from '../../../events/hub.ts';
import { getClaimReceipt, insertClaimReceipt } from '../repositories/claim-receipt-repository.ts';
import { getLockByKey, upsertClaimLock } from '../repositories/lock-repository.ts';
import { getRepositoryById } from '../repositories.ts';
import {
  countActiveRuns,
  getRunById,
  insertRunRecord,
  requireRun,
} from '../repositories/run-repository.ts';
import { markTaskProcessing } from '../repositories/task-write-repository.ts';
import {
  getEffectiveMaxConcurrency as getDbEffectiveMaxConcurrency,
  getTaskAgentProvider,
  requireRepositoryForTask,
  requireTask,
} from '../runs.ts';
import {
  LEASE_DURATION_MS,
  assertCapacityAvailable,
  assertTaskClaimable,
  buildClaimResponse,
  evaluateLockFencing,
  validateClaimReceiptTask,
} from '../services/admission-service.ts';
import { claimIntakeUsecase } from './claim-intake-usecase.ts';

/** Dispatches to the Intake claim path (no repo lock, scratch cwd) when the
 * task hasn't resolved a scope yet, otherwise performs the atomic
 * implementation claim across all resolved canonical paths (specs/2026-10-25-message-intake/01-
 * contracts-and-lifecycle.md "Admission has two concrete purposes"). Callers
 * (direct REST claim and bulk admission) never need to know which kind of
 * attempt this is. */
export function claimTaskUsecase(
  db: Database,
  taskId: string,
  request: ClaimTaskRequest,
): ClaimTaskResponse {
  const existingReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
  if (existingReceipt) {
    const existingRun = requireRun(db, existingReceipt.run_id);
    if (existingRun.purpose === 'intake') {
      return claimIntakeUsecase(db, taskId, request);
    }
    validateClaimReceiptTask(existingReceipt.task_id, taskId, request.ownerId);
    const existingTask = requireTask(db, taskId);
    let workingTreeKey: string | undefined;
    let writeRoots: string[] | undefined;
    if (existingRun.admitted_scope) {
      try {
        writeRoots = JSON.parse(existingRun.admitted_scope) as string[];
        workingTreeKey = writeRoots[0];
      } catch {}
    }
    if (!workingTreeKey) {
      const repository = requireRepositoryForTask(db, existingTask);
      workingTreeKey = repository.canonicalPath;
      writeRoots = [workingTreeKey];
    }
    const lock = getLockByKey(db, workingTreeKey);
    const lockGenerations: Record<string, number> = {};
    if (writeRoots) {
      for (const p of writeRoots) {
        const l = getLockByKey(db, p);
        if (l) {
          lockGenerations[p] = l.generation;
        }
      }
    }
    return buildClaimResponse(
      existingRun,
      existingTask,
      workingTreeKey,
      lock?.lease_expires_at ?? new Date().toISOString(),
      { writeRoots, lockGenerations },
    );
  }

  const task = requireTask(db, taskId);
  if ((task.stage ?? 'ready') === 'intake') {
    return claimIntakeUsecase(db, taskId, request);
  }

  const resolvedRepoIds =
    task.resolvedRepoIds && task.resolvedRepoIds.length > 0
      ? task.resolvedRepoIds
      : task.repoId
        ? [task.repoId]
        : [];
  if (resolvedRepoIds.length === 0) {
    throw new DomainError('NOT_FOUND', `no repository found for task ${taskId}`);
  }

  const repos: Repository[] = [];
  for (const rid of resolvedRepoIds) {
    const repo = getRepositoryById(db, rid);
    if (!repo) {
      throw new DomainError('NOT_FOUND', `resolved repository ${rid} not found for task ${taskId}`);
    }
    repos.push(repo);
  }

  const canonicalPaths = [...new Set(repos.map((r) => r.canonicalPath))];
  const primaryTreeKey = repos[0].canonicalPath;

  // Validate nested / conflicting paths
  for (let i = 0; i < canonicalPaths.length; i++) {
    for (let j = 0; j < canonicalPaths.length; j++) {
      if (i !== j) {
        const p1 = canonicalPaths[i];
        const p2 = canonicalPaths[j];
        if (p1.startsWith(`${p2}/`) || p2.startsWith(`${p1}/`)) {
          throw new DomainError(
            'VALIDATION_ERROR',
            `Nested repository paths are not allowed in multi-repo scope: ${p1} and ${p2}`,
          );
        }
      }
    }
  }

  const runId = `run_${randomUUID()}`;
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  const deadlineAt = new Date(Date.now() + TASK_TIMEOUT_MS).toISOString();
  const provider = getTaskAgentProvider(db, taskId);

  let finalLockGenerations: Record<string, number> = {};
  let finalRunGeneration = 1;

  const applyAtomically = db.transaction(() => {
    // Re-verify receipt inside transaction
    const insideReceipt = getClaimReceipt(db, request.ownerId, request.idempotencyKey);
    if (insideReceipt) {
      validateClaimReceiptTask(insideReceipt.task_id, taskId, request.ownerId);
      const existingRun = requireRun(db, insideReceipt.run_id);
      const existingTask = requireTask(db, taskId);
      const replayedLockGens: Record<string, number> = {};
      for (const p of canonicalPaths) {
        const l = getLockByKey(db, p);
        if (l) {
          replayedLockGens[p] = l.generation;
        }
      }
      return buildClaimResponse(existingRun, existingTask, primaryTreeKey, leaseExpiresAt, {
        writeRoots: canonicalPaths,
        lockGenerations: replayedLockGens,
      });
    }

    const currentTask = requireTask(db, taskId);
    assertTaskClaimable(currentTask);

    const activeCount = countActiveRuns(db);
    const effectiveCap = getDbEffectiveMaxConcurrency(db);
    assertCapacityAvailable(activeCount, effectiveCap);

    const lockGenerations: Record<string, number> = {};
    for (const p of canonicalPaths) {
      const lock = getLockByKey(db, p);
      const ownerRun = lock?.owner_run_id ? getRunById(db, lock.owner_run_id) : null;
      const nextGen = evaluateLockFencing(
        lock,
        ownerRun?.status ?? null,
        ownerRun?.id ?? null,
        request.generation,
        p,
      );
      lockGenerations[p] = nextGen;
    }

    finalLockGenerations = lockGenerations;
    finalRunGeneration = Math.max(...Object.values(lockGenerations), 1);

    for (const p of canonicalPaths) {
      upsertClaimLock(db, p, runId, lockGenerations[p], leaseExpiresAt, now);
    }

    insertRunRecord(db, {
      id: runId,
      taskId,
      provider,
      ownerToken: request.ownerId,
      lockGeneration: finalRunGeneration,
      startedAt: now,
      deadlineAt,
      purpose: 'implementation',
      admittedScope: canonicalPaths,
      inputRevision: currentTask.intakeRevision ?? 0,
      policyHash: null,
    });
    markTaskProcessing(db, taskId, now);
    insertClaimReceipt(db, {
      ownerId: request.ownerId,
      idempotencyKey: request.idempotencyKey,
      taskId,
      runId,
      generation: finalRunGeneration,
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

  const createdRun = requireRun(db, runId);
  return buildClaimResponse(createdRun, updatedTask, primaryTreeKey, leaseExpiresAt, {
    writeRoots: canonicalPaths,
    lockGenerations: finalLockGenerations,
  });
}
