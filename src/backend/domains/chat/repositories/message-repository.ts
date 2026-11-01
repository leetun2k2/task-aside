// Message database access (SPECIFICATION.md §2 C-01, TASKS.md T11, LC-04a, LC-04c, LC-04d).
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Message, MessageSender } from '../../../../contracts/chat.ts';

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  in_reply_to_request_id: string | null;
  created_at: string;
  origin_task_id: string | null;
}

export function rowToMessage(row: MessageRow, fallbackTaskId: string): Message {
  return {
    id: row.id,
    // `origin_task_id` is the authoritative attribution once backfilled
    // (04-delegation-and-follow-up.md "Shared conversation does not mean
    // shared task state"); `fallbackTaskId` only covers a read path that has
    // not been updated to pass the stored origin through yet.
    taskId: row.origin_task_id ?? fallbackTaskId,
    conversationId: row.conversation_id,
    sender: row.role as MessageSender,
    content: row.content,
    inReplyToRequestId: row.in_reply_to_request_id,
    createdAt: row.created_at,
  };
}

export function updateMessageContent(
  db: Database,
  messageId: string,
  content: string,
  updatedAt: string,
): void {
  // Messages have no separate `updated_at` column; this bumps the owning
  // conversation's `updated_at` so SSE/REST reconciliation observes the
  // correction, matching how every other mutation here touches it.
  db.query('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
  const row = db.query('SELECT conversation_id FROM messages WHERE id = ?').get(messageId) as {
    conversation_id: string;
  } | null;
  if (row) {
    touchConversationUpdatedAt(db, row.conversation_id, updatedAt);
  }
}

export function findConversationById(db: Database, conversationId: string): { id: string } | null {
  return db.query('SELECT id FROM conversations WHERE id = ?').get(conversationId) as {
    id: string;
  } | null;
}

/** @deprecated ambiguous once a conversation is shared by more than one
 * task (04-delegation-and-follow-up.md); returns the oldest task only for
 * backward-compatible single-task call sites. Prefer
 * `findTaskIdsByConversationId` and require an explicit target when more
 * than one task shares the conversation. */
export function findTaskIdByConversationId(db: Database, conversationId: string): string | null {
  const row = db
    .query('SELECT id FROM tasks WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 1')
    .get(conversationId) as {
    id: string;
  } | null;
  return row?.id ?? null;
}

export function findTaskIdsByConversationId(db: Database, conversationId: string): string[] {
  const rows = db
    .query('SELECT id FROM tasks WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function findConversationIdByTaskId(db: Database, taskId: string): string | null {
  const row = db.query('SELECT conversation_id FROM tasks WHERE id = ?').get(taskId) as {
    conversation_id: string;
  } | null;
  return row?.conversation_id ?? null;
}

export function insertMessageRecord(
  db: Database,
  message: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    inReplyToRequestId?: string | null;
    createdAt: string;
    originTaskId: string;
  },
): void {
  db.query(
    `INSERT INTO messages
      (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
       source_event_seq, created_at, origin_task_id)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    message.id,
    message.conversationId,
    message.role,
    message.content,
    message.inReplyToRequestId ?? null,
    message.createdAt,
    message.originTaskId,
  );
}

export function insertInputRequiredMessage(
  db: Database,
  params: {
    id: string;
    conversationId: string;
    question: string;
    sourceRunId?: string | null;
    sourceEventSeq?: number | null;
    createdAt: string;
    originTaskId: string;
  },
): void {
  db.query(
    `INSERT INTO messages
      (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
       source_event_seq, created_at, origin_task_id)
     VALUES (?, ?, 'agent', ?, NULL, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.conversationId,
    params.question,
    params.sourceRunId ?? null,
    params.sourceEventSeq ?? null,
    params.createdAt,
    params.originTaskId,
  );
}

export function upsertAgentCompletedMessage(
  db: Database,
  params: {
    messageId: string;
    conversationId: string;
    content: string;
    runId: string;
    sequence: number;
    createdAt: string;
    originTaskId: string;
  },
): void {
  db.query(
    `INSERT INTO messages
      (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
       source_event_seq, created_at, origin_task_id)
     VALUES (?, ?, 'agent', ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       source_run_id = excluded.source_run_id,
       source_event_seq = excluded.source_event_seq`,
  ).run(
    params.messageId,
    params.conversationId,
    params.content,
    params.runId,
    params.sequence,
    params.createdAt,
    params.originTaskId,
  );
}

export function touchConversationUpdatedAt(
  db: Database,
  conversationId: string,
  updatedAt: string,
): void {
  db.query('UPDATE conversations SET updated_at = ? WHERE id = ?').run(updatedAt, conversationId);
}

export function findMessagesPage(
  db: Database,
  conversationId: string,
  limit: number,
  after?: { createdAt: string; id: string },
): MessageRow[] {
  const params: SQLQueryBindings[] = [conversationId];
  let afterClause = '';
  if (after) {
    afterClause = 'AND (created_at > ? OR (created_at = ? AND id > ?))';
    params.push(after.createdAt, after.createdAt, after.id);
  }
  params.push(limit + 1);

  return db
    .query(
      `SELECT id, conversation_id, role, content, in_reply_to_request_id, created_at, origin_task_id
       FROM messages
       WHERE conversation_id = ? ${afterClause}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...params) as MessageRow[];
}
