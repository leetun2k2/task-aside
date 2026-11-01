// Run context read projections (RF-39, LC-03a).
// Pure read-only queries for run/task context assembly without write transactions or locks.
import type { Database } from 'bun:sqlite';
import { type TaskContext, getTaskContextUsecase } from './usecases/get-task-context-usecase.ts';

export type { ChildTaskSummary } from './repositories/task-query-repository.ts';
export type { TaskContext } from './usecases/get-task-context-usecase.ts';

export function getTaskContext(db: Database, taskId: string): TaskContext {
  return getTaskContextUsecase(db, taskId);
}
