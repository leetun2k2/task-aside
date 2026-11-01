// HITL reply cross-domain application action (SPECIFICATION.md §2, ARCHITECTURE.md §3, LC-04b).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { CreateMessageInput, Message, MessageSender } from '../../contracts/chat.ts';
import {
  findConversationById,
  findTaskIdsByConversationId,
  insertMessageRecord,
  rowToMessage,
  touchConversationUpdatedAt,
} from '../domains/chat/repositories/message-repository.ts';
import {
  findPendingHitlRun,
  resolvePendingHitlRun,
} from '../domains/task/repositories/run-repository.ts';
import { findTaskRowById } from '../domains/task/repositories/task-query-repository.ts';
import {
  resolveIntakePendingQuestion,
  resumeTaskFromHitl,
} from '../domains/task/repositories/task-write-repository.ts';
import { DomainError } from '../errors.ts';
import { eventHub } from '../events/hub.ts';

export interface ReplyHitlOptions {
  beforeCommit?: (message: Message) => void;
}

/** Finds the task (among those sharing `conversationId`) that owns the
 * pending request `inReplyToRequestId` — checking both the Intake
 * checkpoint (task-level, no retained run) and implementation HITL
 * (run-level, retained run/lock) — and the resolution kind so the caller can
 * apply the right state transition. Never guesses by picking "the first
 * task linked to the conversation" (04-delegation-and-follow-up.md "reject
 * ambiguous/stale targets"): an explicit `targetTaskId` must also match when
 * more than one task shares the conversation. */
function findTaskOwningPendingRequest(
  db: Database,
  conversationId: string,
  requestId: string,
  targetTaskId: string | undefined,
): { taskId: string; kind: 'intake'; runId: null } | { taskId: string; kind: 'implementation'; runId: string } {
  const candidateTaskIds = findTaskIdsByConversationId(db, conversationId);
  const scoped = targetTaskId
    ? candidateTaskIds.filter((id) => id === targetTaskId)
    : candidateTaskIds;
  if (targetTaskId && scoped.length === 0) {
    throw new DomainError(
      'FORBIDDEN',
      `task ${targetTaskId} is not part of conversation ${conversationId}`,
    );
  }
  if (!targetTaskId && candidateTaskIds.length > 1) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `conversation ${conversationId} is shared by multiple tasks; targetTaskId is required`,
    );
  }

  for (const taskId of scoped) {
    const taskRow = findTaskRowById(db, taskId);
    if (taskRow?.intake_pending_request_id === requestId) {
      return { taskId, kind: 'intake', runId: null };
    }
    const run = findPendingHitlRun(db, taskId);
    if (run && run.pending_input_request_id === requestId && run.purpose === 'implementation') {
      return { taskId, kind: 'implementation', runId: run.id };
    }
  }

  throw new DomainError('REQUEST_ALREADY_RESOLVED', 'no matching pending input request');
}

export function replyHitlUsecase(
  db: Database,
  conversationId: string,
  input: CreateMessageInput,
  sender: MessageSender = 'user',
  options?: ReplyHitlOptions,
): Message {
  if (input.inReplyToRequestId === undefined || input.inReplyToRequestId === null) {
    throw new DomainError('VALIDATION_ERROR', 'inReplyToRequestId required for HITL reply');
  }

  const conversation = findConversationById(db, conversationId);
  if (!conversation) {
    throw new DomainError('NOT_FOUND', `conversation not found: ${conversationId}`);
  }

  const owner = findTaskOwningPendingRequest(
    db,
    conversationId,
    input.inReplyToRequestId,
    input.targetTaskId,
  );
  const taskId = owner.taskId;

  const id = randomUUID();
  const now = new Date().toISOString();
  let taskVersion = 1;
  let nextStatus: 'processing' | 'todo' = 'processing';

  const msg = rowToMessage(
    {
      id,
      conversation_id: conversationId,
      role: sender,
      content: input.content,
      in_reply_to_request_id: input.inReplyToRequestId,
      created_at: now,
      origin_task_id: taskId,
    },
    taskId,
  );

  const applyAtomically = db.transaction(() => {
    insertMessageRecord(db, {
      id,
      conversationId,
      role: sender,
      content: input.content,
      inReplyToRequestId: input.inReplyToRequestId,
      createdAt: now,
      originTaskId: taskId,
    });

    if (owner.kind === 'intake') {
      // No retained run/slot to resume — queue a brand-new bounded Intake
      // attempt instead (01-contracts-and-lifecycle.md).
      resolveIntakePendingQuestion(db, taskId, now);
      nextStatus = 'todo';
    } else {
      resolvePendingHitlRun(db, owner.runId, now);
      resumeTaskFromHitl(db, taskId, now);
      nextStatus = 'processing';
    }
    touchConversationUpdatedAt(db, conversationId, now);

    if (options?.beforeCommit) {
      options.beforeCommit(msg);
    }

    const taskRow = findTaskRowById(db, taskId);
    taskVersion = taskRow?.version ?? 1;
  });

  applyAtomically();

  // Defer publications until AFTER the outer commit
  eventHub.publish({
    type: 'message.completed',
    data: {
      messageId: id,
      taskId,
      conversationId,
      role: sender,
      content: input.content,
      createdAt: now,
    },
  });

  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId,
      status: nextStatus,
      previousStatus: 'hitl',
      version: taskVersion,
      updatedAt: now,
    },
  });

  return msg;
}
