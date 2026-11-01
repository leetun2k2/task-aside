// Update task application action (SPECIFICATION.md §2, TASKS.md T11, LC-03c).
import type { Database } from 'bun:sqlite';
import type { UpdateTaskInput } from '../../../../contracts/task.ts';
import { eventHub } from '../../../events/hub.ts';
import { updateMessageContent } from '../../chat/repositories/message-repository.ts';
import type { TaskRecord } from '../repositories/task-query-repository.ts';
import { updateTaskRecord } from '../repositories/task-write-repository.ts';
import {
  prepareTaskUpdate,
  validateInitialMessageEditRules,
  validateTaskEditRules,
} from '../services/task-service.ts';
import { requireTaskUsecase } from './get-task-usecase.ts';

export function updateTaskUsecase(db: Database, id: string, input: UpdateTaskInput): TaskRecord {
  const task = requireTaskUsecase(db, id);
  validateTaskEditRules(task);

  const prepared = prepareTaskUpdate(task, input);
  const now = new Date().toISOString();

  const apply = db.transaction(() => {
    updateTaskRecord(db, {
      id,
      title: prepared.title,
      priority: prepared.priority,
      updatedAt: prepared.updatedAt,
    });

    if (input.message !== undefined) {
      validateInitialMessageEditRules(task);
      if (!task.initialMessageId) {
        throw new Error(`task ${id} has no initial message to correct`);
      }
      updateMessageContent(db, task.initialMessageId, input.message, now);
    }
  });
  apply();

  const updated = requireTaskUsecase(db, id);

  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: updated.id,
      status: updated.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: updated.updatedAt,
    },
  });

  return updated;
}
