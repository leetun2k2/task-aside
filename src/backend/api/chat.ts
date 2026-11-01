// Public REST routes for conversation messages (SPECIFICATION.md §2 C-01, LC-04a).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { CreateMessageInputSchema } from '../../contracts/chat.ts';
import { findConversationIdByTaskId } from '../domains/chat/repositories/message-repository.ts';
import { appendMessageUsecase } from '../domains/chat/usecases/append-message-usecase.ts';
import { listMessagesUsecase } from '../domains/chat/usecases/list-messages-usecase.ts';
import { DomainError } from './errors.ts';

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new DomainError('VALIDATION_ERROR', `invalid limit: ${raw}`);
  }
  return value;
}

export function mountChatRoutes(app: Hono, db: Database): void {
  app.get('/api/conversations/:id/messages', (c) =>
    c.json(
      listMessagesUsecase(db, c.req.param('id'), {
        cursor: c.req.query('cursor') ?? undefined,
        limit: parseLimit(c.req.query('limit')),
      }),
    ),
  );

  app.post('/api/conversations/:id/messages', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid message input', parsed.error.flatten());
    }
    return c.json(appendMessageUsecase(db, c.req.param('id'), parsed.data, 'user'), 201);
  });

  app.get('/api/tasks/:id/messages', (c) => {
    const conversationId = findConversationIdByTaskId(db, c.req.param('id'));
    if (!conversationId) {
      throw new DomainError('NOT_FOUND', `task not found: ${c.req.param('id')}`);
    }
    return c.json(
      listMessagesUsecase(db, conversationId, {
        cursor: c.req.query('cursor') ?? undefined,
        limit: parseLimit(c.req.query('limit')),
      }),
    );
  });

  app.post('/api/tasks/:id/messages', async (c) => {
    const conversationId = findConversationIdByTaskId(db, c.req.param('id'));
    if (!conversationId) {
      throw new DomainError('NOT_FOUND', `task not found: ${c.req.param('id')}`);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = CreateMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid message input', parsed.error.flatten());
    }
    return c.json(
      appendMessageUsecase(
        db,
        conversationId,
        { ...parsed.data, targetTaskId: parsed.data.targetTaskId ?? c.req.param('id') },
        'user',
      ),
      201,
    );
  });
}
