// Admission and claim domain service rules (SPECIFICATION.md §2, TASKS.md T11, LC-05a).
import { MAX_WORKERS, TASK_TIMEOUT_MS } from '../../../../contracts/pool.ts';
import type { ClaimTaskResponse, RunStatus } from '../../../../contracts/run.ts';
import { DomainError } from '../../../errors.ts';
import type { RunLockRow } from '../repositories/lock-repository.ts';
import type { RunRow } from '../repositories/run-repository.ts';
import type { TaskRecord } from '../tasks.ts';

export const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['running', 'hitl']);
export const LEASE_DURATION_MS = 60_000;

export const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function getEffectiveMaxConcurrency(configured: number | null | undefined): number {
  const cap = configured ?? MAX_WORKERS;
  return Math.min(cap, MAX_WORKERS);
}

export function assertCapacityAvailable(activeCount: number, effectiveCap: number): void {
  if (activeCount >= effectiveCap) {
    throw new DomainError(
      'CAPACITY_EXCEEDED',
      `at capacity: ${activeCount}/${effectiveCap} active runs across the shared backend`,
    );
  }
}

export function assertTaskClaimable(task: TaskRecord): void {
  if (task.status === 'processing') {
    throw new DomainError('LOCK_HELD', `task ${task.id} is already being processed`);
  }

  if (task.status !== 'todo') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `cannot claim task in status '${task.status}'; only 'todo' tasks may be claimed`,
    );
  }
}

export function evaluateLockFencing(
  lock: RunLockRow | null,
  ownerRunStatus: RunStatus | null,
  ownerRunId: string | null,
  requestedGeneration: number,
  workingTreeKey: string,
): number {
  if (!lock) {
    return 1;
  }

  if (lock.quarantined === 1) {
    throw new DomainError('LOCK_HELD', `working tree is quarantined: ${workingTreeKey}`);
  }

  if (ownerRunStatus && ACTIVE_RUN_STATUSES.has(ownerRunStatus)) {
    throw new DomainError(
      'LOCK_HELD',
      `working tree lock is currently held by run ${ownerRunId ?? lock.owner_run_id}`,
    );
  }

  if (requestedGeneration > 0 && requestedGeneration !== lock.generation) {
    throw new DomainError(
      'STALE_GENERATION',
      `stale generation: expected ${lock.generation}, got ${requestedGeneration}`,
    );
  }

  return lock.generation + 1;
}

export function validateClaimReceiptTask(
  existingTaskId: string,
  requestedTaskId: string,
  ownerId: string,
): void {
  if (existingTaskId !== requestedTaskId) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `idempotency key already used by owner ${ownerId} for a different task ` +
        `(${existingTaskId}); reusing it for ${requestedTaskId} conflicts`,
    );
  }
}

export function effectiveDeadline(run: Pick<RunRow, 'deadline_at' | 'started_at'>): string {
  return (
    run.deadline_at ?? new Date(new Date(run.started_at).getTime() + TASK_TIMEOUT_MS).toISOString()
  );
}

export function buildClaimResponse(
  run: RunRow,
  task: TaskRecord,
  workingTreeKey: string | undefined,
  leaseExpiresAt: string,
  extra?: {
    writeRoots?: string[];
    lockGenerations?: Record<string, number>;
  },
): ClaimTaskResponse {
  let writeRoots = extra?.writeRoots;
  if (!writeRoots && run.admitted_scope) {
    try {
      writeRoots = JSON.parse(run.admitted_scope) as string[];
    } catch {}
  }
  if (!writeRoots) {
    writeRoots = workingTreeKey ? [workingTreeKey] : [];
  }

  const lockGenerations =
    extra?.lockGenerations ?? (workingTreeKey ? { [workingTreeKey]: run.lock_generation } : {});

  return {
    protocolVersion: 'v2',
    runId: run.id,
    purpose: run.purpose ?? 'implementation',
    generation: run.lock_generation,
    runFence: run.lock_generation,
    leaseExpiresAt,
    taskSnapshot: task,
    deadlineAt: effectiveDeadline(run),
    workingTreeKey,
    writeRoots,
    lockGenerations,
    inputRevision: run.input_revision ?? task.intakeRevision ?? 0,
    policyHash: run.policy_hash ?? undefined,
  };
}

export function rankRunnableTasks(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99),
  );
}
