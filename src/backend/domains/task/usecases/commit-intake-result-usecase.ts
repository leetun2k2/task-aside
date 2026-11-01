// Internal Intake result commit (specs/2026-10-25-message-intake/01-
// contracts-and-lifecycle.md "Internal Intake result commit: Engine-only,
// fenced, idempotent acceptance; checks revision, outcome, children/follow-
// up and stop proof; delegation completes the parent atomically."). The
// engine only forwards a schema-valid payload; this usecase independently
// re-validates persistent constraints and authorization before ever
// touching task state — never trusting model output as authority.
import type { Database } from 'bun:sqlite';
import type {
  CommitIntakeResultRequest,
  FailIntakeRequest,
  IntakeResult,
} from '../../../../contracts/intake.ts';
import { DomainError } from '../../../errors.ts';
import { eventHub } from '../../../events/hub.ts';
import { insertMessageRecord } from '../../chat/repositories/message-repository.ts';
import { getRepositoryById } from '../repositories.ts';
import { requireRun } from '../repositories/run-repository.ts';
import {
  activateStagedChild,
  completeTaskAsDelegated,
  failTaskIntake,
  finalizeIntakeRun,
  promoteStagedVerificationTask,
  recordIntakePendingQuestion,
  resolveTaskFromIntake,
} from '../repositories/task-write-repository.ts';
import { reconcileBlockedParents } from '../tasks.ts';
import { getTaskUsecase, requireTaskUsecase } from './get-task-usecase.ts';

function assertIntakeRunFencing(
  run: { owner_token: string; lock_generation: number; purpose: string },
  ownerId: string,
  generation: number,
): void {
  if (run.purpose !== 'intake') {
    throw new DomainError('VALIDATION_ERROR', 'run is not an Intake attempt');
  }
  if (run.owner_token !== ownerId || run.lock_generation !== generation) {
    throw new DomainError(
      'STALE_GENERATION',
      `owner/generation mismatch for run: expected owner=${run.owner_token} generation=${run.lock_generation}`,
    );
  }
}

export function commitIntakeResultUsecase(
  db: Database,
  runId: string,
  request: CommitIntakeResultRequest,
): { ok: true; taskId: string; outcome: IntakeResult['action'] } {
  const run = requireRun(db, runId);

  // Authority & fencing must be validated before serving receipts or committing effects
  assertIntakeRunFencing(run, request.ownerId, request.generation);

  // Idempotent re-commit: a lost ACK retry of the identical request must be
  // a no-op, never a second side effect (01-contracts-and-lifecycle.md).
  // Changed retry payloads on a finished run are rejected with CONFLICT.
  if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
    let cachedOutcome: IntakeResult['action'] = 'implement';
    if (run.terminal_outcome && run.terminal_outcome !== 'failed') {
      cachedOutcome = run.terminal_outcome as IntakeResult['action'];
    } else {
      try {
        const state = run.process_state ? JSON.parse(run.process_state) : null;
        if (state?.intakeOutcome && state.intakeOutcome !== 'failed') {
          cachedOutcome = state.intakeOutcome;
        }
      } catch {
        // Keep default
      }
    }
    if (request.result.action !== cachedOutcome) {
      throw new DomainError(
        'REQUEST_ALREADY_RESOLVED',
        `conflicting intake outcome on retry: existing is '${cachedOutcome}', retry requested '${request.result.action}'`,
      );
    }
    return { ok: true, taskId: run.task_id, outcome: cachedOutcome };
  }

  const task = requireTaskUsecase(db, run.task_id);
  if (task.stage !== 'intake' || task.status !== 'processing') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `task ${task.id} is not awaiting an Intake commit (stage=${task.stage}, status=${task.status})`,
    );
  }

  if (
    run.input_revision !== undefined &&
    task.intakeRevision !== undefined &&
    run.input_revision !== task.intakeRevision
  ) {
    throw new DomainError(
      'STALE_GENERATION',
      `stale input revision: run has revision ${run.input_revision}, but task is at revision ${task.intakeRevision}`,
    );
  }

  const now = new Date().toISOString();
  const { result } = request;

  if (result.action === 'implement') {
    return commitImplement(db, run.id, task.id, task, result, now);
  }
  if (result.action === 'delegate') {
    return commitDelegate(db, run.id, task.id, task, result, now);
  }
  return commitRequestInput(db, run.id, task.id, result, now);
}

function commitImplement(
  db: Database,
  runId: string,
  taskId: string,
  task: ReturnType<typeof requireTaskUsecase>,
  result: Extract<IntakeResult, { action: 'implement' }>,
  now: string,
): { ok: true; taskId: string; outcome: 'implement' } {
  const authorized = new Set(task.authorizedRepoIds ?? []);
  const uniqueRepoIds = [...new Set(result.repoIds)];
  for (const repoId of uniqueRepoIds) {
    if (!authorized.has(repoId)) {
      throw new DomainError(
        'FORBIDDEN',
        `Intake selected repository ${repoId}, which is outside this task's authorized scope`,
      );
    }
    if (!getRepositoryById(db, repoId)) {
      throw new DomainError('NOT_FOUND', `Intake selected an unregistered repository: ${repoId}`);
    }
  }

  // "Keep explicit user title and priority" (03-agent-routing.md) — the
  // backend enforces this, not the model.
  const finalTitle = task.titleIsOverride ? task.title : result.title;
  const finalPriority = task.priorityIsOverride ? task.priority : result.priority;

  const apply = db.transaction(() => {
    resolveTaskFromIntake(db, {
      id: taskId,
      title: finalTitle,
      priority: finalPriority,
      primaryRepoId: uniqueRepoIds[0] as string,
      resolvedRepoIds: uniqueRepoIds,
      executionProvider: result.executionProvider,
      intakeResultJson: JSON.stringify(result),
      updatedAt: now,
    });
    finalizeIntakeRun(db, runId, 'implement', now);
    insertMessageRecord(db, {
      id: `msg_intake_${runId}`,
      conversationId: task.conversationId,
      role: 'agent',
      content: summarizeImplement(uniqueRepoIds, result),
      inReplyToRequestId: null,
      createdAt: now,
      originTaskId: taskId,
    });
  });
  apply();

  const updated = requireTaskUsecase(db, taskId);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId,
      status: updated.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: now,
    },
  });

  return { ok: true, taskId, outcome: 'implement' };
}

function summarizeImplement(
  repoIds: string[],
  result: Extract<IntakeResult, { action: 'implement' }>,
): string {
  const lines = [
    `**Intake resolved this task.**`,
    `- Repositories: ${repoIds.join(', ')}`,
    `- Priority: ${result.priority}`,
    `- Execution provider: ${result.executionProvider}`,
  ];
  if (result.reason) {
    lines.push(`- Reason: ${result.reason}`);
  }
  return lines.join('\n');
}

function commitDelegate(
  db: Database,
  runId: string,
  taskId: string,
  task: ReturnType<typeof requireTaskUsecase>,
  result: Extract<IntakeResult, { action: 'delegate' }>,
  now: string,
): { ok: true; taskId: string; outcome: 'delegate' } {
  const uniqueChildIds = [...new Set(result.childTaskIds)];
  if (result.verificationTaskId && uniqueChildIds.includes(result.verificationTaskId)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'verificationTaskId cannot also appear as a work child',
    );
  }

  const children = uniqueChildIds.map((childId) => {
    const child = getTaskUsecase(db, childId);
    if (!child || child.parentId !== taskId || child.blockKind !== 'staged_by_parent_intake') {
      throw new DomainError(
        'VALIDATION_ERROR',
        `${childId} is not a staged child created by this Intake attempt`,
      );
    }
    return child;
  });

  let verification: ReturnType<typeof getTaskUsecase> | null = null;
  if (result.verificationTaskId) {
    verification = getTaskUsecase(db, result.verificationTaskId);
    if (
      !verification ||
      verification.parentId !== taskId ||
      verification.blockKind !== 'staged_by_parent_intake'
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `verificationTaskId ${result.verificationTaskId} is not a staged verification task created by this Intake attempt`,
      );
    }
    const prereqs = verification.blockedOnChildIds ?? [];
    for (const prereqId of prereqs) {
      if (!uniqueChildIds.includes(prereqId)) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `verification task waits on ${prereqId}, which is not one of this delegation's work children`,
        );
      }
    }
  }

  const allStaged = db
    .query("SELECT id FROM tasks WHERE parent_id = ? AND block_kind = 'staged_by_parent_intake'")
    .all(taskId) as { id: string }[];
  const unlistedStagedChildIds = allStaged
    .map((c) => c.id)
    .filter((id) => !uniqueChildIds.includes(id) && id !== result.verificationTaskId);

  const apply = db.transaction(() => {
    for (const child of children) {
      activateStagedChild(db, child.id, now);
    }
    for (const orphanedId of unlistedStagedChildIds) {
      db.query(
        `UPDATE tasks SET status = 'cancelled', block_kind = NULL, blocked_reason = 'Cancelled: omitted from parent delegation', updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, orphanedId);
    }
    if (verification) {
      promoteStagedVerificationTask(db, verification.id, now);
    }
    completeTaskAsDelegated(db, taskId, now);
    finalizeIntakeRun(db, runId, 'delegate', now);
    insertMessageRecord(db, {
      id: `msg_intake_${runId}`,
      conversationId: task.conversationId,
      role: 'agent',
      content: summarizeDelegate(uniqueChildIds, result),
      inReplyToRequestId: null,
      createdAt: now,
      originTaskId: taskId,
    });
  });
  apply();

  // Verification eligibility is prerequisite-gated the same way a legacy
  // waiting parent is (tasks.ts); if every listed child happens to already
  // be terminal (unlikely immediately after activation, but possible on a
  // retried commit), let it become eligible without waiting for the next
  // poll tick.
  reconcileBlockedParents(db);

  const updatedParent = requireTaskUsecase(db, taskId);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId,
      status: updatedParent.status,
      version: updatedParent.version,
      blockedReason: updatedParent.blockedReason,
      updatedAt: now,
    },
  });
  for (const child of children) {
    const updatedChild = requireTaskUsecase(db, child.id);
    eventHub.publish({
      type: 'task.status_changed',
      data: {
        taskId: child.id,
        status: updatedChild.status,
        version: updatedChild.version,
        blockedReason: updatedChild.blockedReason,
        updatedAt: now,
      },
    });
  }
  for (const orphanedId of unlistedStagedChildIds) {
    const updatedOrphan = requireTaskUsecase(db, orphanedId);
    eventHub.publish({
      type: 'task.status_changed',
      data: {
        taskId: orphanedId,
        status: updatedOrphan.status,
        version: updatedOrphan.version,
        blockedReason: updatedOrphan.blockedReason,
        updatedAt: now,
      },
    });
  }

  return { ok: true, taskId, outcome: 'delegate' };
}

function summarizeDelegate(
  childIds: string[],
  result: Extract<IntakeResult, { action: 'delegate' }>,
): string {
  const lines = [
    `**Intake delegated this task and it is now done.**`,
    `- Delegated to: ${childIds.join(', ')}`,
  ];
  if (result.verificationTaskId) {
    lines.push(`- Verification task: ${result.verificationTaskId}`);
  }
  if (result.reason) {
    lines.push(`- Reason: ${result.reason}`);
  }
  lines.push(
    '_This completion means delegation succeeded, not that the delegated work has finished._',
  );
  return lines.join('\n');
}

function commitRequestInput(
  db: Database,
  runId: string,
  taskId: string,
  result: Extract<IntakeResult, { action: 'request_input' }>,
  now: string,
): { ok: true; taskId: string; outcome: 'request_input' } {
  const requestId = `intake_req_${runId}`;
  const task = requireTaskUsecase(db, taskId);

  const apply = db.transaction(() => {
    finalizeIntakeRun(db, runId, 'request_input', now);
    recordIntakePendingQuestion(db, {
      taskId,
      requestId,
      question: result.question,
      updatedAt: now,
    });
    insertMessageRecord(db, {
      id: `msg_intake_${runId}`,
      conversationId: task.conversationId,
      role: 'agent',
      content: result.question,
      inReplyToRequestId: null,
      createdAt: now,
      originTaskId: taskId,
    });
  });
  apply();

  eventHub.publish({
    type: 'input_required',
    data: { requestId, taskId, conversationId: task.conversationId, question: result.question },
  });
  const updated = requireTaskUsecase(db, taskId);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId,
      status: updated.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: now,
    },
  });

  return { ok: true, taskId, outcome: 'request_input' };
}

export function failIntakeUsecase(
  db: Database,
  runId: string,
  request: FailIntakeRequest,
): { ok: true } {
  const run = requireRun(db, runId);

  if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
    return { ok: true };
  }
  if (run.purpose !== 'intake') {
    throw new DomainError('VALIDATION_ERROR', 'run is not an Intake attempt');
  }
  if (run.owner_token !== request.ownerId || run.lock_generation !== request.generation) {
    throw new DomainError('STALE_GENERATION', 'owner/generation mismatch for run');
  }

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    finalizeIntakeRun(db, runId, 'failed', now);
    failTaskIntake(db, run.task_id, request.reason, now);
  });
  apply();

  const updated = requireTaskUsecase(db, run.task_id);
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: run.task_id,
      status: updated.status,
      version: updated.version,
      blockedReason: updated.blockedReason,
      updatedAt: now,
    },
  });

  return { ok: true };
}
