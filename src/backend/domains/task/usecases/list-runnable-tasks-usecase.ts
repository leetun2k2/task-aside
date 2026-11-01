// List runnable tasks usecase (SPECIFICATION.md §2, TASKS.md T11, LC-05a).
import type { Database } from 'bun:sqlite';
import { findRunnableTasks } from '../repositories/task-admission-repository.ts';
import { rankRunnableTasks } from '../services/admission-service.ts';
import { type TaskRecord, reconcileBlockedParents, rowToTask } from '../tasks.ts';

export function listRunnableTasksUsecase(db: Database): TaskRecord[] {
  reconcileBlockedParents(db);
  const rows = findRunnableTasks(db);
  return rankRunnableTasks(rows.map(rowToTask));
}
