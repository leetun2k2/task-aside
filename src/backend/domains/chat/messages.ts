// Chat domain compatibility exports (SPECIFICATION.md §2 C-01, T11, LC-04a).
import type { Database } from 'bun:sqlite';
import type { CreateMessageInput, Message, MessageSender } from '../../../contracts/chat.ts';
import {
  findConversationIdByTaskId,
  findTaskIdByConversationId,
} from './repositories/message-repository.ts';
import { appendMessageUsecase } from './usecases/append-message-usecase.ts';
import { type MessagePage, listMessagesUsecase } from './usecases/list-messages-usecase.ts';

export type { MessagePage };

export function getTaskIdForConversation(db: Database, conversationId: string): string | null {
  return findTaskIdByConversationId(db, conversationId);
}

export function getConversationIdForTask(db: Database, taskId: string): string | null {
  return findConversationIdByTaskId(db, taskId);
}

export function appendMessage(
  db: Database,
  conversationId: string,
  input: CreateMessageInput,
  sender: MessageSender = 'user',
): Message {
  return appendMessageUsecase(db, conversationId, input, sender);
}

export function listMessages(
  db: Database,
  conversationId: string,
  options: { cursor?: string; limit?: number } = {},
): MessagePage {
  return listMessagesUsecase(db, conversationId, options);
}
