// Settings domain schema (SPECIFICATION.md §3, TASKS.md T15).
export const SETTINGS_DOMAIN_SCHEMA: readonly string[] = [
  `CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_provider TEXT NOT NULL CHECK (default_provider IN ('codex', 'claude')),
    max_concurrency INTEGER NOT NULL CHECK (max_concurrency >= 1 AND max_concurrency <= 10),
    updated_at TEXT NOT NULL
  )`,
  `INSERT INTO settings (id, default_provider, max_concurrency, updated_at)
    VALUES (1, 'codex', 3, '2026-10-18T00:00:00.000Z')`,
  'ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
];

export const ROOT_WORKSPACE_SCHEMA: readonly string[] = [
  'ALTER TABLE settings ADD COLUMN root_workspace TEXT DEFAULT NULL',
];

export const HARNESS_SETTINGS_SCHEMA: readonly string[] = [
  `CREATE TABLE settings_v7 (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_provider TEXT NOT NULL CHECK (default_provider IN ('claude', 'codex', 'agy')),
    max_concurrency INTEGER NOT NULL CHECK (max_concurrency >= 1 AND max_concurrency <= 10),
    root_workspace TEXT DEFAULT NULL,
    active_harnesses TEXT NOT NULL DEFAULT '["claude","codex","agy"]',
    updated_at TEXT NOT NULL
  )`,
  `INSERT INTO settings_v7 (id, default_provider, max_concurrency, root_workspace, active_harnesses, updated_at)
    SELECT id,
      CASE WHEN default_provider = 'codex' THEN 'claude' ELSE default_provider END,
      max_concurrency,
      root_workspace,
      '["claude","codex","agy"]',
      updated_at
    FROM settings`,
  'DROP TABLE settings',
  'ALTER TABLE settings_v7 RENAME TO settings',
  'PRAGMA foreign_keys = OFF',
  `CREATE TABLE tasks_v7 (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    parent_id TEXT REFERENCES tasks(id),
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    status TEXT NOT NULL CHECK (status IN ('todo', 'processing', 'hitl', 'done', 'error', 'cancelled')),
    agent_provider TEXT NOT NULL CHECK (agent_provider IN ('claude', 'codex', 'agy')),
    block_kind TEXT,
    blocked_reason TEXT,
    depth INTEGER NOT NULL CHECK (depth IN (0, 1)),
    blocked_on_child_ids TEXT,
    origin_run_id TEXT,
    origin_key TEXT,
    created_at TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  'INSERT INTO tasks_v7 SELECT * FROM tasks',
  'DROP TABLE tasks',
  'ALTER TABLE tasks_v7 RENAME TO tasks',
  'CREATE INDEX idx_tasks_status_priority_created ON tasks(status, priority, created_at)',
  'CREATE INDEX idx_tasks_parent_id ON tasks(parent_id)',
  'CREATE INDEX idx_tasks_repo_id ON tasks(repository_id)',
  'CREATE INDEX idx_tasks_conversation_id ON tasks(conversation_id)',
  `CREATE UNIQUE INDEX idx_tasks_origin_dedup ON tasks(origin_run_id, origin_key)
    WHERE origin_run_id IS NOT NULL AND origin_key IS NOT NULL`,
  'PRAGMA foreign_keys = ON',
];
