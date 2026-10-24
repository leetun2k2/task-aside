// Chat domain schema (ARCHITECTURE.md §4, SPECIFICATION.md §6): conversations
// and messages. Only `src/backend` may apply this against SQLite (AGENTS.md §3).
//
// `conversations` is split out from `messages` because the task domain's
// `tasks` table has a FK to `conversations(id)` (SPECIFICATION.md §6) and must
// be created after it but before `messages`; see migrations.ts for ordering.
export const CHAT_CONVERSATIONS_SCHEMA: readonly string[] = [
  `CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export const CHAT_MESSAGES_SCHEMA: readonly string[] = [
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
    content TEXT NOT NULL,
    in_reply_to_request_id TEXT,
    source_run_id TEXT,
    source_event_seq INTEGER,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at, id)',
  `CREATE UNIQUE INDEX idx_messages_source_event ON messages(source_run_id, source_event_seq)
    WHERE source_run_id IS NOT NULL AND source_event_seq IS NOT NULL`,
];
