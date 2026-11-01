// Append message application action (SPECIFICATION.md §2 C-01, TASKS.md T11, LC-04a, LC-04b).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { CreateMessageInput, Message, MessageSender } from '../../../../contracts/chat.ts';
import { DomainError } from '../../../errors.ts';
import { eventHub } from '../../../events/hub.ts';
import { replyHitlUsecase } from '../../../usecases/reply-hitl-usecase.ts';
import {
  findConversationById,
  findTaskIdsByConversationId,
  insertMessageRecord,
  rowToMessage,
  touchConversationUpdatedAt,
} from '../repositories/message-repository.ts';

export interface AppendMessageOptions {
  beforeCommit?: (message: Message) => void;
}

export function appendMessageUsecase(
  db: Database,
  conversationId: string,
  input: CreateMessageInput,
  sender: MessageSender = 'user',
  options?: AppendMessageOptions,
): Message {
  // If inReplyToRequestId is provided, delegate to the cross-domain HITL reply usecase
  if (input.inReplyToRequestId !== undefined && input.inReplyToRequestId !== null) {
    return replyHitlUsecase(db, conversationId, input, sender, options);
  }

  const conversation = findConversationById(db, conversationId);
  if (!conversation) {
    throw new DomainError('NOT_FOUND', `conversation not found: ${conversationId}`);
  }

  // Exact task targeting (04-delegation-and-follow-up.md "Shared conversation
  // does not mean shared task state"): a shared conversation never lets a
  // general post silently pick the first linked task. A single-task
  // conversation (every pre-Intake conversation, and the overwhelming
  // majority after it) still works without callers having to pass anything.
  const taskIds = findTaskIdsByConversationId(db, conversationId);
  let targetTaskId: string;
  if (input.targetTaskId) {
    if (!taskIds.includes(input.targetTaskId)) {
      throw new DomainError(
        'FORBIDDEN',
        `task ${input.targetTaskId} is not part of conversation ${conversationId}`,
      );
    }
    targetTaskId = input.targetTaskId;
  } else if (taskIds.length === 1) {
    targetTaskId = taskIds[0] as string;
  } else {
    throw new DomainError(
      'VALIDATION_ERROR',
      `conversation ${conversationId} is shared by multiple tasks; targetTaskId is required`,
    );
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  const msg = rowToMessage(
    {
      id,
      conversation_id: conversationId,
      role: sender,
      content: input.content,
      in_reply_to_request_id: null,
      created_at: now,
      origin_task_id: targetTaskId,
    },
    targetTaskId,
  );

  const applyAtomically = db.transaction(() => {
    insertMessageRecord(db, {
      id,
      conversationId,
      role: sender,
      content: input.content,
      inReplyToRequestId: null,
      createdAt: now,
      originTaskId: targetTaskId,
    });

    touchConversationUpdatedAt(db, conversationId, now);

    if (options?.beforeCommit) {
      options.beforeCommit(msg);
    }
  });

  applyAtomically();

  // Defer publication until AFTER the outer commit
  eventHub.publish({
    type: 'message.completed',
    data: {
      messageId: id,
      taskId: targetTaskId,
      conversationId,
      role: sender,
      content: input.content,
      createdAt: now,
    },
  });

  return msg;
}
