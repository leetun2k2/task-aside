// Task domain service and rules (SPECIFICATION.md §2, TASKS.md T11, LC-03b, LC-03c, LC-03d).
import type { UpdateTaskInput } from '../../../../contracts/task.ts';
import { DomainError } from '../../../errors.ts';
import type { TaskRecord } from '../repositories/task-query-repository.ts';

export const MAX_CHILDREN_PER_TASK = 5;

export function validateChildTaskRules(
  parent: TaskRecord | null,
  childCount: number,
): { depth: 0 | 1 } {
  if (!parent) {
    throw new DomainError('NOT_FOUND', 'parent task not found');
  }
  if (parent.depth !== 0) {
    throw new DomainError(
      'CHILD_LIMIT_EXCEEDED',
      'parent task is itself a child; grandchildren are not allowed',
    );
  }
  if (childCount >= MAX_CHILDREN_PER_TASK) {
    throw new DomainError(
      'CHILD_LIMIT_EXCEEDED',
      `parent task already has the maximum of ${MAX_CHILDREN_PER_TASK} children`,
    );
  }
  return { depth: 1 };
}

export function validateTaskEditRules(task: TaskRecord): void {
  if (task.status === 'processing') {
    throw new DomainError('INVALID_TRANSITION', 'cannot edit a task while it is processing');
  }
}

// A Message correction is only safe before the task's first admission
// (01-contracts-and-lifecycle.md "Before first admission, task edit can
// correct its own initial Message atomically with its input revision.
// After admission, corrections are new task-targeted user messages.").
// `stage === 'ready'` means Intake already accepted a scope (or a legacy
// task was backfilled already-resolved) — editing the Message at that point
// would silently invalidate a decision the caller cannot see was discarded,
// so it is rejected rather than allowed to drift from the accepted result.
export function validateInitialMessageEditRules(task: TaskRecord): void {
  if (task.stage !== 'intake' || task.status !== 'todo') {
    throw new DomainError(
      'INVALID_TRANSITION',
      'the initial Message can only be corrected before first admission; post a new message instead',
    );
  }
}

export function prepareTaskUpdate(
  task: TaskRecord,
  input: UpdateTaskInput,
): { title: string; priority: string; updatedAt: string } {
  return {
    title: input.title ?? task.title,
    priority: input.priority ?? task.priority,
    updatedAt: new Date().toISOString(),
  };
}

export function classifyCancellation(task: TaskRecord): 'noop' | 'live' | 'immediate' {
  if (task.status === 'done' || task.status === 'cancelled') {
    return 'noop';
  }
  if (task.status === 'processing' || task.status === 'hitl') {
    return 'live';
  }
  if (task.status === 'todo' || task.status === 'error') {
    return 'immediate';
  }
  throw new DomainError('INVALID_TRANSITION', `cannot cancel task in status '${task.status}'`);
}

export function validateTaskRetryRules(task: TaskRecord, isQuarantined: boolean): void {
  if (task.status !== 'error') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `cannot retry task in status '${task.status}'; only 'error' tasks may be retried`,
    );
  }
  if (isQuarantined) {
    throw new DomainError('LOCK_HELD', 'working tree is quarantined');
  }
}
