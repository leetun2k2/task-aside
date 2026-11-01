// List messages application action (SPECIFICATION.md §2 C-01, TASKS.md T11, LC-04a).
import type { Database } from 'bun:sqlite';
import type { Message } from '../../../../contracts/chat.ts';
import { DomainError } from '../../../errors.ts';
import {
  findConversationById,
  findMessagesPage,
  findTaskIdByConversationId,
  rowToMessage,
} from '../repositories/message-repository.ts';
import { decodeCursor, encodeCursor, sanitizePageLimit } from '../services/chat-service.ts';

export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}

export function listMessagesUsecase(
  db: Database,
  conversationId: string,
  options: { cursor?: string; limit?: number } = {},
): MessagePage {
  const conversation = findConversationById(db, conversationId);
  if (!conversation) {
    throw new DomainError('NOT_FOUND', `conversation not found: ${conversationId}`);
  }

  const limit = sanitizePageLimit(options.limit);
  const taskId = findTaskIdByConversationId(db, conversationId) ?? '';

  let after: { createdAt: string; id: string } | undefined;
  if (options.cursor) {
    after = decodeCursor(options.cursor);
  }

  const rows = findMessagesPage(db, conversationId, limit, after);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const nextCursor = hasMore
    ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
    : null;

  return {
    messages: page.map((row) => rowToMessage(row, taskId)),
    nextCursor,
  };
}
