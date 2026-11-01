// Cancel task application action (SPECIFICATION.md §2, TASKS.md T11, LC-03d).
import type { Database } from 'bun:sqlite';
import { eventHub } from '../../../events/hub.ts';
import type { TaskRecord } from '../repositories/task-query-repository.ts';
import { cancelTaskRecord } from '../repositories/task-write-repository.ts';
import { requestRunCancellationForTask } from '../runs.ts';
import { classifyCancellation } from '../services/task-service.ts';
import { reconcileBlockedParents } from '../tasks.ts';
import { requireTaskUsecase } from './get-task-usecase.ts';

export function cancelTaskUsecase(db: Database, id: string): TaskRecord {
  const task = requireTaskUsecase(db, id);
  const action = classifyCancellation(task);

  if (action === 'noop') {
    return task;
  }

  if (action === 'live') {
    return requestRunCancellationForTask(db, id);
  }

  const now = new Date().toISOString();
  cancelTaskRecord(db, id, now);
  const updated = requireTaskUsecase(db, id);

  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: updated.id,
      status: updated.status,
      previousStatus: task.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: updated.updatedAt,
    },
  });

  reconcileBlockedParents(db);

  return updated;
}
