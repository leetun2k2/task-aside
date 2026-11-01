import type { Database } from 'bun:sqlite';
// Dedicated task admission and ownership logic (RF-40, LC-05a).
// Handles candidate selection, capacity limits, atomic claims, and generation fencing.
import type {
  AdmitSkipReason,
  ClaimTaskRequest,
  ClaimTaskResponse,
} from '../../../contracts/run.ts';
import type { TaskRecord } from './tasks.ts';
import { type AdmitResult, admitNextTaskUsecase } from './usecases/admit-next-task-usecase.ts';
import { claimTaskUsecase } from './usecases/claim-task-usecase.ts';
import { listRunnableTasksUsecase } from './usecases/list-runnable-tasks-usecase.ts';

export type { AdmitResult };

/**
 * Claims a specific, already-known-eligible task.
 * Atomic read-decide-write sequence inside an immediate-mode SQLite transaction.
 */
export function claimTask(
  db: Database,
  taskId: string,
  request: ClaimTaskRequest,
): ClaimTaskResponse {
  return claimTaskUsecase(db, taskId, request);
}

/**
 * Atomic bulk admission: picks the single best eligible task via a short indexed query.
 */
export function admitNextEligibleTask(
  db: Database,
  request: { ownerId: string; idempotencyKey: string },
): AdmitResult {
  return admitNextTaskUsecase(db, request);
}

export function listRunnableTasks(db: Database): TaskRecord[] {
  return listRunnableTasksUsecase(db);
}
