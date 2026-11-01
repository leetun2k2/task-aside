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

// Message-first task + Intake schema (specs/2026-10-25-message-intake):
//
// `repository_id` becomes nullable because a Message-only task has no
// resolved repository until Intake accepts a scope — SQLite cannot drop a
// NOT NULL constraint with ALTER COLUMN, so this recreates `tasks` the same
// way migration 007 (HARNESS_SETTINGS_SCHEMA) already did to widen
// `agent_provider`; the eligibility index dropped by that recreate
// (`idx_tasks_eligible`, added by migration 005 and never restored by 007)
// is restored here too.
//
// New columns:
//  - candidate_repo_ids: submitted repo hints (JSON array) — relevance only.
//  - authorized_repo_ids: caller's authorized repo set at creation time
//    (JSON array) — permission, never widened after creation (01-contracts-
//    and-lifecycle.md "Candidate scope is permission, resolved scope is
//    intent").
//  - resolved_repo_ids: accepted Intake scope (JSON array), authoritative
//    for implementation admission once `stage = 'ready'`.
//  - stage: 'intake' (default for new Message-only tasks; no repo claimed
//    yet, eligible for the Intake attempt only) or 'ready' (repo scope
//    resolved, eligible for the implementation claim through the existing
//    single-lock path against `repository_id`, the primary resolved repo).
//  - execution_provider: Intake's validated provider choice; distinct from
//    `agent_provider`, which legacy code paths still read as the dispatch
//    default.
//  - intake_revision: bumped whenever a new Intake attempt is queued for
//    this task (fresh question reply, explicit retry) so a stale/duplicate
//    result commit can be rejected.
//  - intake_result: last accepted Intake result JSON (raw, execution
//    metadata only — chat gets a short summary instead, 01-contracts-and-
//    lifecycle.md "Raw JSON stays in execution metadata").
//  - initial_message_id: the task's own initial chat message reference
//    (nullable only until the legacy backfill in migrations.ts runs).
//
// `runs.purpose` distinguishes an Intake attempt (no repo lock, scratch
// cwd, restricted MCP tools) from an implementation attempt (existing
// single-lock path). `messages.origin_task_id` replaces the
// one-task-per-conversation assumption so a shared conversation can
// attribute each message to the task that posted it.
export const MESSAGE_INTAKE_SCHEMA: readonly string[] = [
  'PRAGMA foreign_keys = OFF',
  `CREATE TABLE tasks_v8 (
    id TEXT PRIMARY KEY,
    repository_id TEXT REFERENCES repositories(id),
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
    version INTEGER NOT NULL DEFAULT 1,
    candidate_repo_ids TEXT,
    authorized_repo_ids TEXT,
    resolved_repo_ids TEXT,
    stage TEXT NOT NULL DEFAULT 'ready' CHECK (stage IN ('intake', 'ready')),
    execution_provider TEXT,
    intake_revision INTEGER NOT NULL DEFAULT 0,
    intake_result TEXT,
    initial_message_id TEXT
  )`,
  'INSERT INTO tasks_v8 SELECT *, NULL, NULL, NULL, \'ready\', NULL, 0, NULL, NULL FROM tasks',
  'DROP TABLE tasks',
  'ALTER TABLE tasks_v8 RENAME TO tasks',
  'CREATE INDEX idx_tasks_status_priority_created ON tasks(status, priority, created_at)',
  'CREATE INDEX idx_tasks_parent_id ON tasks(parent_id)',
  'CREATE INDEX idx_tasks_repo_id ON tasks(repository_id)',
  'CREATE INDEX idx_tasks_conversation_id ON tasks(conversation_id)',
  `CREATE UNIQUE INDEX idx_tasks_origin_dedup ON tasks(origin_run_id, origin_key)
    WHERE origin_run_id IS NOT NULL AND origin_key IS NOT NULL`,
  'CREATE INDEX idx_tasks_eligible ON tasks(status, block_kind, priority, enqueued_at)',
  'PRAGMA foreign_keys = ON',
  "ALTER TABLE runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'implementation'",
  'ALTER TABLE messages ADD COLUMN origin_task_id TEXT',
  'CREATE INDEX idx_messages_origin_task ON messages(origin_task_id)',
  // The Intake HITL checkpoint has no retained run/slot to resume (01-
  // contracts-and-lifecycle.md "without a retained active run or slot"), so
  // it cannot reuse `runs.pending_input_request_id` (implementation HITL,
  // which DOES keep its run/lock retained). These two columns are the
  // task-level pairing for that distinct checkpoint.
  'ALTER TABLE tasks ADD COLUMN intake_pending_request_id TEXT',
  'ALTER TABLE tasks ADD COLUMN intake_pending_question TEXT',
  // "Keep explicit user title and priority" (03-agent-routing.md): the
  // backend — not the model — enforces that a caller-supplied title/
  // priority survives Intake unchanged. These flags record whether the
  // *original* create request supplied one, independent of whatever
  // deterministic/default value ended up in `title`/`priority`.
  'ALTER TABLE tasks ADD COLUMN title_is_override INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN priority_is_override INTEGER NOT NULL DEFAULT 0',
];

export const INTAKE_RUNTIME_COMPLETION_SCHEMA: readonly string[] = [
  'ALTER TABLE runs ADD COLUMN admitted_scope TEXT',
  'ALTER TABLE runs ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN policy_hash TEXT',
  'ALTER TABLE runs ADD COLUMN terminal_outcome TEXT',
];
