// Get task application action (SPECIFICATION.md §2, TASKS.md T11, LC-03a).
import type { Database } from 'bun:sqlite';
import { DomainError } from '../../../errors.ts';
import {
  type TaskRecord,
  findActiveRunForTask,
  findTaskRowById,
  rowToTask,
} from '../repositories/task-query-repository.ts';

// Simple read bypasses empty service layer: usecase -> repository
export function getTaskUsecase(db: Database, id: string): TaskRecord | null {
  const row = findTaskRowById(db, id);
  if (!row) return null;

  const task = rowToTask(row);
  const activeRun = findActiveRunForTask(db, id);
  if (activeRun) {
    task.activeRunId = activeRun.id;
    task.pendingInputRequestId = activeRun.pendingInputRequestId;
  } else if (row.intake_pending_request_id) {
    // Intake HITL checkpoint: no retained run/slot (01-contracts-and-
    // lifecycle.md), so there is no activeRunId, only the task-level pairing.
    task.pendingInputRequestId = row.intake_pending_request_id;
  }
  return task;
}

export function requireTaskUsecase(db: Database, id: string): TaskRecord {
  const task = getTaskUsecase(db, id);
  if (!task) {
    throw new DomainError('NOT_FOUND', `task not found: ${id}`);
  }
  return task;
}
