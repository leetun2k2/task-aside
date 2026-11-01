// List tasks application action (SPECIFICATION.md §2, TASKS.md T11, LC-03a).
import type { Database } from 'bun:sqlite';
import {
  type ListTasksFilter,
  type TaskRecord,
  findActiveRunsForTasks,
  findTaskRows,
  rowToTask,
} from '../repositories/task-query-repository.ts';

// Simple read bypasses empty service layer: usecase -> repository
export function listTasksUsecase(db: Database, filter: ListTasksFilter): TaskRecord[] {
  const rows = findTaskRows(db, filter);
  const activeRunByTask = findActiveRunsForTasks(db);

  return rows.map((r) => {
    const t = rowToTask(r);
    const active = activeRunByTask.get(t.id);
    if (active) {
      t.activeRunId = active.id;
      t.pendingInputRequestId = active.pendingInputRequestId;
    }
    return t;
  });
}
