// Chat domain (SPECIFICATION.md §2 C-01, T11): message append + cursor
// pagination. Independent of the task domain except for the `conversation_id`
// cross-link (AGENTS.md §3: Task and Chat remain independent domain modules).
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { CreateMessageInput, Message, MessageSender } from '../../../contracts/chat.ts';
import { DomainError } from '../../api/errors.ts';
import { eventHub } from '../../events/hub.ts';

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  in_reply_to_request_id: string | null;
  created_at: string;
}

function rowToMessage(row: MessageRow, taskId: string): Message {
  return {
    id: row.id,
    taskId,
    conversationId: row.conversation_id,
    sender: row.role as MessageSender,
    content: row.content,
    inReplyToRequestId: row.in_reply_to_request_id,
    createdAt: row.created_at,
  };
}

function requireConversation(db: Database, conversationId: string): void {
  const row = db.query('SELECT id FROM conversations WHERE id = ?').get(conversationId) as {
    id: string;
  } | null;
  if (!row) {
    throw new DomainError('NOT_FOUND', `conversation not found: ${conversationId}`);
  }
}

export function getTaskIdForConversation(db: Database, conversationId: string): string | null {
  const row = db.query('SELECT id FROM tasks WHERE conversation_id = ?').get(conversationId) as {
    id: string;
  } | null;
  return row?.id ?? null;
}

export function getConversationIdForTask(db: Database, taskId: string): string | null {
  const row = db.query('SELECT conversation_id FROM tasks WHERE id = ?').get(taskId) as {
    conversation_id: string;
  } | null;
  return row?.conversation_id ?? null;
}

export function appendMessage(
  db: Database,
  conversationId: string,
  input: CreateMessageInput,
  sender: MessageSender = 'user',
): Message {
  requireConversation(db, conversationId);

  const taskId = getTaskIdForConversation(db, conversationId);
  const now = new Date().toISOString();

  // If inReplyToRequestId is provided, pair atomically with pending HITL request
  if (input.inReplyToRequestId !== undefined && input.inReplyToRequestId !== null) {
    if (!taskId) {
      throw new DomainError('REQUEST_ALREADY_RESOLVED', 'no matching pending input request');
    }

    const run = db
      .query(
        `SELECT id, status, pending_input_request_id
         FROM runs
         WHERE task_id = ? AND pending_input_request_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(taskId) as { id: string; status: string; pending_input_request_id: string } | null;

    if (!run || run.pending_input_request_id !== input.inReplyToRequestId) {
      throw new DomainError('REQUEST_ALREADY_RESOLVED', 'no matching pending input request');
    }

    const id = randomUUID();

    const applyAtomically = db.transaction(() => {
      db.query(
        `INSERT INTO messages
          (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
           source_event_seq, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(id, conversationId, sender, input.content, input.inReplyToRequestId ?? null, now);

      db.query(
        `UPDATE runs
         SET pending_input_request_id = NULL, status = 'running', heartbeat_at = ?
         WHERE id = ?`,
      ).run(now, run.id);

      db.query(
        "UPDATE tasks SET status = 'processing', updated_at = ?, version = version + 1 WHERE id = ?",
      ).run(now, taskId);

      db.query('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    });

    applyAtomically();

    const msg = rowToMessage(
      {
        id,
        conversation_id: conversationId,
        role: sender,
        content: input.content,
        in_reply_to_request_id: input.inReplyToRequestId,
        created_at: now,
      },
      taskId,
    );

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

    const taskRow = db.query('SELECT version FROM tasks WHERE id = ?').get(taskId) as {
      version: number;
    } | null;
    eventHub.publish({
      type: 'task.status_changed',
      data: {
        taskId,
        status: 'processing',
        previousStatus: 'hitl',
        version: taskRow?.version ?? 1,
        updatedAt: now,
      },
    });

    return msg;
  }

  // Regular user/agent message (no inReplyToRequestId).
  // Note: If task is processing, message is safely queued in the conversation
  // for the next turn. If task is terminal, message is stored without resurrecting.
  const id = randomUUID();

  const applyAtomically = db.transaction(() => {
    db.query(
      `INSERT INTO messages
        (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
         source_event_seq, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ).run(id, conversationId, sender, input.content, now);

    db.query('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  });

  applyAtomically();

  const msg = rowToMessage(
    {
      id,
      conversation_id: conversationId,
      role: sender,
      content: input.content,
      in_reply_to_request_id: null,
      created_at: now,
    },
    taskId ?? '',
  );

  eventHub.publish({
    type: 'message.completed',
    data: {
      messageId: id,
      taskId: taskId ?? '',
      conversationId,
      role: sender,
      content: input.content,
      createdAt: now,
    },
  });

  return msg;
}

export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex === -1) {
    throw new DomainError('VALIDATION_ERROR', 'invalid pagination cursor');
  }
  return { createdAt: decoded.slice(0, separatorIndex), id: decoded.slice(separatorIndex + 1) };
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export function listMessages(
  db: Database,
  conversationId: string,
  options: { cursor?: string; limit?: number } = {},
): MessagePage {
  requireConversation(db, conversationId);

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const taskId = getTaskIdForConversation(db, conversationId) ?? '';

  const params: SQLQueryBindings[] = [conversationId];
  let afterClause = '';
  if (options.cursor) {
    const { createdAt, id } = decodeCursor(options.cursor);
    afterClause = 'AND (created_at > ? OR (created_at = ? AND id > ?))';
    params.push(createdAt, createdAt, id);
  }
  params.push(limit + 1);

  const rows = db
    .query(
      `SELECT id, conversation_id, role, content, in_reply_to_request_id, created_at
       FROM messages
       WHERE conversation_id = ? ${afterClause}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...params) as MessageRow[];

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
