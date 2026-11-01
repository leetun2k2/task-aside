// Conversation database access (SPECIFICATION.md §2, TASKS.md T11, LC-03b).
import type { Database } from 'bun:sqlite';

export function insertConversation(
  db: Database,
  conversationId: string,
  createdAt: string,
  updatedAt: string,
): void {
  db.query('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(
    conversationId,
    createdAt,
    updatedAt,
  );
}
