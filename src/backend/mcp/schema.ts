// MCP domain schema (SPECIFICATION.md §4, §8.1; ARCHITECTURE.md §9; T14).
// Manages managed run-scoped tokens, external paired tokens, and one-time pairing codes.
// Only `src/backend` may apply this against SQLite (AGENTS.md §3).

export const MCP_DOMAIN_SCHEMA: readonly string[] = [
  `CREATE TABLE mcp_tokens (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('mcp-managed', 'mcp-external')),
    client_name TEXT NOT NULL,
    run_id TEXT REFERENCES runs(id),
    task_id TEXT REFERENCES tasks(id),
    allowed_tools TEXT NOT NULL,
    allowed_repo_ids TEXT,
    allowed_task_ids TEXT,
    expires_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX idx_mcp_tokens_token ON mcp_tokens(token)',
  'CREATE INDEX idx_mcp_tokens_run_id ON mcp_tokens(run_id)',
  `CREATE TABLE mcp_pairings (
    code TEXT PRIMARY KEY,
    client_name TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
];
