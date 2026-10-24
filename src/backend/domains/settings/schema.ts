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
