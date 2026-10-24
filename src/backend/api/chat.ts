// Public REST routes for conversation messages (SPECIFICATION.md §2 C-01).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { CreateMessageInputSchema } from '../../contracts/chat.ts';
import { appendMessage, getConversationIdForTask, listMessages } from '../domains/chat/messages.ts';
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
      listMessages(db, c.req.param('id'), {
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
    return c.json(appendMessage(db, c.req.param('id'), parsed.data, 'user'), 201);
  });

  app.get('/api/tasks/:id/messages', (c) => {
    const conversationId = getConversationIdForTask(db, c.req.param('id'));
    if (!conversationId) {
      throw new DomainError('NOT_FOUND', `task not found: ${c.req.param('id')}`);
    }
    return c.json(
      listMessages(db, conversationId, {
        cursor: c.req.query('cursor') ?? undefined,
        limit: parseLimit(c.req.query('limit')),
      }),
    );
  });

  app.post('/api/tasks/:id/messages', async (c) => {
    const conversationId = getConversationIdForTask(db, c.req.param('id'));
    if (!conversationId) {
      throw new DomainError('NOT_FOUND', `task not found: ${c.req.param('id')}`);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = CreateMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid message input', parsed.error.flatten());
    }
    return c.json(appendMessage(db, conversationId, parsed.data, 'user'), 201);
  });
}
