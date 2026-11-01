// Retry task application action (SPECIFICATION.md §2, TASKS.md T11, LC-03d).
import type { Database } from 'bun:sqlite';
import { eventHub } from '../../../events/hub.ts';
import { getRepositoryById } from '../repositories.ts';
import type { TaskRecord } from '../repositories/task-query-repository.ts';
import {
  bumpIntakeRevision,
  isWorkingTreeQuarantined,
  retryTaskRecord,
} from '../repositories/task-write-repository.ts';
import { validateTaskRetryRules } from '../services/task-service.ts';
import { requireTaskUsecase } from './get-task-usecase.ts';

export function retryTaskUsecase(db: Database, id: string): TaskRecord {
  const task = requireTaskUsecase(db, id);
  const repository = task.repoId ? getRepositoryById(db, task.repoId) : null;
  const isQuarantined = repository ? isWorkingTreeQuarantined(db, repository.canonicalPath) : false;

  validateTaskRetryRules(task, isQuarantined);

  const now = new Date().toISOString();
  retryTaskRecord(db, id, now);
  // A stale commit from the failed attempt's own run must never match a
  // fresh retry (01-contracts-and-lifecycle.md "failed Intake is retried as
  // Intake"); bumping the revision here, not just on a HITL reply, closes
  // that gap for explicit-retry-after-failure too.
  if ((task.stage ?? 'ready') === 'intake') {
    bumpIntakeRevision(db, id);
  }
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

  return updated;
}
