// Task domain schema (ARCHITECTURE.md §4, SPECIFICATION.md §6): repositories,
// tasks, runs, run locks and run event dedup receipts. Only `src/backend` may
// apply this against SQLite (AGENTS.md §3).
export const TASK_DOMAIN_SCHEMA: readonly string[] = [
  `CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    default_provider TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX idx_repositories_canonical_path ON repositories(canonical_path)',
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    parent_id TEXT REFERENCES tasks(id),
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    status TEXT NOT NULL CHECK (status IN ('todo', 'processing', 'hitl', 'done', 'error', 'cancelled')),
    agent_provider TEXT NOT NULL CHECK (agent_provider IN ('codex', 'claude')),
    block_kind TEXT,
    blocked_reason TEXT,
    depth INTEGER NOT NULL CHECK (depth IN (0, 1)),
    blocked_on_child_ids TEXT,
    origin_run_id TEXT,
    origin_key TEXT,
    created_at TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX idx_tasks_status_priority_created ON tasks(status, priority, created_at)',
  'CREATE INDEX idx_tasks_parent_id ON tasks(parent_id)',
  'CREATE INDEX idx_tasks_repo_id ON tasks(repository_id)',
  'CREATE INDEX idx_tasks_conversation_id ON tasks(conversation_id)',
  `CREATE UNIQUE INDEX idx_tasks_origin_dedup ON tasks(origin_run_id, origin_key)
    WHERE origin_run_id IS NOT NULL AND origin_key IS NOT NULL`,
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    provider TEXT NOT NULL,
    provider_session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'hitl', 'done', 'error', 'cancelled', 'uncertain')),
    owner_token TEXT NOT NULL,
    lock_generation INTEGER NOT NULL,
    process_state TEXT,
    pending_input_request_id TEXT,
    log_path TEXT,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER
  )`,
  'CREATE INDEX idx_runs_task_started ON runs(task_id, started_at)',
  'CREATE INDEX idx_runs_status ON runs(status)',
  `CREATE TABLE run_locks (
    working_tree_key TEXT PRIMARY KEY,
    owner_run_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    lease_expires_at TEXT NOT NULL,
    quarantined INTEGER NOT NULL CHECK (quarantined IN (0, 1)),
    quarantined_reason TEXT,
    quarantined_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE run_event_receipts (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
  )`,
];

// Handoff single-writer repair schema (specs/2026-10-24-handoff-single-writer.md):
// durable yield intent (never proof of exit — see domains/task/runs.ts
// recordYieldIntent/finalizeRun), a cooperative cancel-request marker for live
// runs, and durable per-principal external create_task idempotency receipts
// that survive a backend restart (replacing the in-memory-only dedup used for
// claims, which is fine for claims but not for external task creation).
export const HANDOFF_SINGLE_WRITER_SCHEMA: readonly string[] = [
  'ALTER TABLE runs ADD COLUMN pending_yield_child_ids TEXT',
  'ALTER TABLE runs ADD COLUMN pending_yield_reason TEXT',
  'ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT',
  `CREATE TABLE external_task_receipts (
    token_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (token_id, idempotency_key)
  )`,
];

// Polling worker-pool schema (specs/2026-10-24-polling-worker-pool.md):
// durable per-attempt deadline (60 min from claim, survives restart/resume),
// a cooperative timeout-request marker mirroring `cancel_requested_at`, a
// durable claim/admission receipts table replacing the process-local
// `pendingClaimByTask` map (so idempotency survives a backend restart and
// serves both the per-id claim route and the new bulk-admission route), and
// indexes that make eligible-task selection a short indexed lookup instead of
// a full-backlog scan.
//
// Settings default bump: migration 003 unconditionally inserts
// max_concurrency=3 for every database (old and new) the first time it runs,
// and that insert must never be edited. This statement approximates "new
// installations default to eight" by bumping only rows still at that exact
// shipped default — it cannot distinguish "never customized" from
// "deliberately set back to 3", so an install that intentionally kept 3 is
// indistinguishable from a fresh one and will also be bumped once. This is a
// one-time cosmetic nudge, not a safety mechanism: the actual admission
// ceiling always uses min(configured, MAX_WORKERS) regardless of what this
// statement does.
export const POLLING_WORKER_POOL_SCHEMA: readonly string[] = [
  'ALTER TABLE runs ADD COLUMN deadline_at TEXT',
  'ALTER TABLE runs ADD COLUMN timeout_requested_at TEXT',
  `CREATE TABLE claim_receipts (
    owner_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, idempotency_key)
  )`,
  'CREATE INDEX idx_tasks_eligible ON tasks(status, block_kind, priority, enqueued_at)',
  'UPDATE settings SET max_concurrency = 8 WHERE id = 1 AND max_concurrency = 3',
];
