# TaskAside — Functional & Technical Specification

> **Status:** MVP contract, unified with ARCHITECTURE.md after M0 (see [T05 evidence/decision record](evidence/T05-feasibility-and-contract-gaps.md)); external agent capabilities remain POC-gated per that record  
> **Version:** 0.4 · **Date:** 2026-10-18  
> **References:** [PRD.md](PRD.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [CONSTITUTION.md](CONSTITUTION.md)

## 1. Normative terms and IDs

**MUST** = required for MVP; **SHOULD** = preferred unless documented exception; **MAY** = optional. `taskId`, `runId`, `conversationId`, and `repositoryId` are opaque unique strings (ULID/UUID acceptable, choose one consistently). All durable timestamps are UTC ISO-8601 or integer epochs, consistently serialized as ISO-8601 to REST. Priority is integer `0..3`, where **0 is highest**.

### Task state definitions

| State | Meaning | Executing process? |
|---|---|---|
| `todo` | Eligible or waiting with explicit reason | No TaskAside-managed run actively writing |
| `processing` | Active run/turn, including acquiring or supervising agent | Usually yes; heartbeat required |
| `hitl` | Explicit human input required | May still retain a paused process; lock remains until safe stop |
| `done` | Run completed successfully under completion policy | No |
| `error` | Run failed or recovery needs intervention | No new writer auto-launched |
| `cancelled` | Task cancelled, no live TaskAside-owned writer | No |

A **blocked** `todo` is not a seventh state: store `blockedReason` and machine-readable `blockKind`/wait condition. Status changes MUST be validated by backend against the active `runId` and fencing generation.

## 2. User behavior contracts

### T-01 Task CRUD

- `POST /api/tasks`: require `title`, `repositoryId`, optional `description`, `priority` (default P2), `agentProvider` (`codex`/`claude`), `parentId`. Validate repo exists and parent belongs to an allowed scope.
- `GET /api/tasks`: filtering by `status`, `priority`, `repositoryId`, `query`; stable order.
- `GET /api/tasks/:id`, `PATCH /api/tasks/:id` (title/description/priority/provider only while not processing; narrow allowed fields).
- `POST /api/tasks/:id/cancel`: queued task cancels immediately; live task becomes `cancel_requested` **internal run flag** and only transitions to `cancelled` after process termination is verified.
- `POST /api/tasks/:id/retry`: explicit retry from `error` once no old run is alive; creates a new run, not reuse old run ID.
- Task delete is out of scope; `cancelled` is retained for traceability.
- Backend MUST reject invalid parent cycles and MUST bound agent-created nesting and count. **Fixed MVP ceilings (T05 decision, not configurable upward):** `depth(root)=0`, `depth(child)=1`; `create_task` is only permitted when the caller's own depth is 0 (a child cannot spawn a grandchild); at most 5 children per task.

### T-02 Grouping and UI

- Sidebar task list nested grouping is **one of** `state→priority` or `priority→state`; both group levels must have accurate counts and collapse states.
- Default: `state→priority`; `done` and `cancelled` collapsed. Subgroup row shows concise task title, P label, repo, minimal state cue. P0/HITL/error should be discoverable without decorative density.
- Search matches title and optionally ID/description; no global full-text search dependency in MVP.
- Selecting task loads its header + conversation; linked `#taskId` navigates to corresponding task; parent breadcrumb/link optional when not null.
- A task header shows `title`, `repository`, `priority`, `status`, `parent link` if any, and `blockedReason` when relevant.
- Conversation has only agent/user messages (Markdown/code blocks) and input composer. No Files/Subtasks/Activity tabs, run cards, interactive HITL cards, or raw output feed.
- Avatar at bottom of sidebar -> small menu -> Settings modal. Configure repositories, default provider, concurrency, local service diagnostics.
- Deadline and advanced UI workflow editors excluded.

### C-01 Chat

- Create one conversation per task when task is created; `conversationId` stored on task. A single conversation can have many execution runs.
- `GET /api/conversations/:id/messages?cursor=...&limit=...` returns chronological messages, stable cursor.
- `POST /api/conversations/:id/messages` accepts user text; validates size and ownership; messages posted during `processing` are **queued for the next safe agent turn**, not injected unpredictably into a live agent.
- Agent messages are appended via authenticated internal run event API or authorized scoped MCP tool. Chat domain owns messages, not task scheduling.
- `request_input` is a **structured operation** with a `requestId`; backend records pending input in run state and surfaces the question as an ordinary agent message. **Pairing is atomic (T05 decision):** the backend transaction for the `input_required` event persists the question message, sets `tasks.status="hitl"`, and sets `runs.pending_request_id=requestId` together. A reply posted with `inReplyToRequestId` matching the current `pending_request_id` atomically inserts the message, clears `pending_request_id`, and sets `tasks.status="processing"`. A reply whose `inReplyToRequestId` does not match the current pending request (already resolved or stale) is rejected idempotently with `409 {code:"REQUEST_ALREADY_RESOLVED"}` — it must not trigger a second resume.
- User messages to a `done`, `error`, or `cancelled` task are stored, but do **not** silently resurrect execution. UI offers explicit reopen/retry action as allowed by policy.

### E-01 Scheduler

- Engine requests runnable candidates/claims through backend; backend is sole SQLite writer.
- Prefer P0 over P1 over P2 over P3 among eligible tasks; FIFO by enqueue timestamp then task ID for ties.
- Configurable `maxConcurrency` (default 3); `maxPerWorkingTree=1` for MVP.
- Canonicalize repository path (symlinks/case sensitivity/platform-specific paths) before deriving lock key; only one TaskAside writer may hold that key.
- Claim + run creation + working-tree lock acquisition MUST be one SQLite transaction in backend. Claim returns `runId`, `lockGeneration`, `leaseExpiresAt`, `taskSnapshot`.
- Engine periodically heartbeats the run. **Lease expiry never by itself authorizes concurrent restart**: reconcile adapter/process tree before releasing lock.
- Child tasks do not imply sibling order. If ordering is required, the engine must express an explicit prerequisite/wait condition in backend task metadata; at minimum the parent may wait for all its children. Avoid generic DAG definition in MVP.
- Priority changes affect only **future claims**, not preemptive interruption of a running task.
- Failure blocks automatic continuation of a dependent parent; unrelated repo work continues.

### E-02 Parent/child delegation

- Managed agents can call MCP `create_task` only within their run scope, with `parentId` set to current task (unless an authorized external agent with broader rights), only when the caller's own `depth` is 0, and only up to 5 children per task.
- Child task receives its own conversation and runs; may select provider only from allowed configured providers.
- Agent yields parent to child tasks via the MCP `yield_task({childTaskIds?, reason?})` tool. Parent must cease writing and release lock **after verified stop** (same verification as E-01); then parent remains `todo` with `blockKind=children` and `blocked_on_child_ids` set, until every listed child reaches a terminal state.
- If any child fails/cancels, parent stays blocked, with user-visible reason and a structured per-child error summary once resumed. No automatic loop of spawning replacement children.
- Use `originRunId` plus caller-provided `idempotencyKey` for child creation; repeated MCP calls must not create duplicates.

### E-03 Agent integration

- Single adapter REST service exposes `codex` and `claude` drivers; engine dispatches via `provider` field.
- Required driver capabilities: `start`, normalized `message.delta` and `message.completed`, `completed`/`failed`, `cancel`, status inspection, optional `resume`, optional structured `input_required`/approval mapping. A provider must explicitly report unsupported capabilities.
- Codex candidate: local **Codex App Server** over JSON-RPC/stdio; save thread ID/turn ID, map events and approval semantics.
- Initial POCs use installed Codex/Claude CLIs and their existing login/configuration following `z-agent-non-interactive`. Codex exec is the baseline harness; App Server remains a candidate for structured runtime control, pending POC evidence.
- Claude driver path: **Claude Code CLI subprocess**, with non-interactive flags verified against its installed version. Verify Bun subprocess control, structured output, auth, MCP and permission behavior. Reconsider SDK integration only if a required CLI capability fails; do not switch silently.
- Code-writing process executes inside registered repo path. Do not build shell commands by string-concatenating user prompts.
- Agent provider configuration is user-owned; TaskAside does not silently grant API/subscription entitlements.

## 3. Internal HTTP contracts (versioned under `/internal/v1`)

Internal endpoints require a supervisor-provisioned bearer credential (`internal.token`, §8.1) distinct from browser access and MCP credentials, plus an `X-TaskAside-Role` header; authorize callers by service role.

**Owner/fencing fields (T05 decision):** `claim`, `heartbeat`, `events`, `finalize`, `input`, and `cancel` all require `ownerId` (the calling execution-engine instance's identifier, stable for its process lifetime) and `generation` (the working-tree lock's fencing counter) in the request body. Backend validates `runs.owner_token == ownerId AND run_locks.generation == generation`; mismatch returns `409 {code:"STALE_GENERATION"}`.

### Backend endpoints

| Method/path | Caller | Semantics |
|---|---|---|
| `GET /internal/v1/tasks/runnable` | engine | Snapshot eligible candidates; no locks granted |
| `POST /internal/v1/tasks/:id/claim` | engine | Atomic claim, create run + lock; idempotency key required |
| `GET /internal/v1/tasks/:id/context` | engine | Task + permitted chat + parent info for instruction builder |
| `POST /internal/v1/runs/:id/heartbeat` | engine | Refresh lease if `ownerId`/`generation` match |
| `POST /internal/v1/runs/:id/events` | engine | Ingest normalized events with run ID + monotonic sequence; enforce idempotency |
| `POST /internal/v1/runs/:id/finalize` | engine | Verify `ownerId`/`generation`; requires `verifiedStopped:true` + `verificationMethod` to apply a terminal transition and release the lock; rejects otherwise |
| `GET /internal/v1/runs/:id` | engine | Authoritative recovery state |
| `POST /internal/v1/runs/:id/mark-uncertain` | supervisor/engine | Move run to `uncertain` and lock to `quarantined`; explicit recovery needed |
| `POST /internal/v1/runs/:id/clear-quarantine` | supervisor (admin override) | Clear quarantine only after verified termination or recorded operator override |

Event envelope (one flat shape — T05 decision, resolving the prior `type`/`data` vs. nested `event` conflict):

```json
{
  "runId": "run_01",
  "sequence": 42,
  "type": "message.completed",
  "timestamp": "2026-10-18T09:00:00Z",
  "data": { "messageId": "msg_01", "content": "Implemented login validation." }
}
```

`type` is one of `message.delta`, `message.completed`, `input_required`, `completed`, `failed`, `cancelled`; `data` is validated per-type via a discriminated union (see ARCHITECTURE.md §6 for exact per-type shapes). `sequence` is a strictly increasing integer per `runId`, starting at 1.

**Idempotency:** backend stores `event_hash = sha256(canonical_json({runId, sequence, type, data}))` keyed by `(runId, sequence)` for persistent event types. No existing receipt → insert, apply side effect, `200` ACK. Existing receipt with the same hash → `200` ACK, no repeated side effect (identical-retry case). Existing receipt with a different hash at the same `sequence` → `409 Conflict {code:"SEQUENCE_CONFLICT"}`. Acknowledgment is required before the engine drops its buffered persistent event; on ACK loss it retries the identical `(runId, sequence, type, data)` tuple. `message.delta` may be transient and coalesced: no promise to durably replay every token, and it is not subject to the hash-dedup guarantee.

### Agent adapter endpoints

| Method/path | Semantics |
|---|---|
| `GET /health` | Process readiness |
| `GET /capabilities` | Available providers and declared feature support |
| `POST /internal/v1/runs` | Start; require `ownerId`, `generation`, and idempotency key |
| `GET /internal/v1/runs/:id` | Current agent process/session state, including `processState: {status, verifiedStoppedAt?, verificationMethod?}` |
| `GET /internal/v1/runs/:id/events?after=seq` | SSE stream with event sequence (buffer/replay best effort) |
| `POST /internal/v1/runs/:id/input` | Reply to pending provider request, if supported; carries `ownerId`/`generation` |
| `POST /internal/v1/runs/:id/cancel` | Cancel process tree (process-group SIGTERM, escalate to SIGKILL); return `verifiedStopped`/`verificationMethod`, never release-on-signal-sent-alone |

Treat network disconnect as **unknown**, not automatically as run failure. Engine reconciles by status API before changing ownership. Verified-stop uses process-group kill plus `ps`-based confirmation (or launch-time identity fingerprint comparison) per T04 evidence — a bare `kill(pid, 0)` check is insufficient because PIDs are reused.

### Public REST and UI SSE

- Task routes listed above; repository routes `GET /api/repositories`, `POST /api/repositories`, settings `GET/PATCH /api/settings`.
- `GET /api/events`: SSE with `task.status_changed`, `message.delta`, `message.completed`, `run.changed`, `input_required`. No raw terminal log events.
- On reconnect, client must **refetch REST snapshot** and subscribe to new SSE events. SSE is best effort; an in-memory hub is not durable history. Avoid snapshot/SSE race by using backend monotonically increasing entity versions and refetching on connect/reconnect or noticing gaps.
- `message.delta` is displayed transiently, keyed by `runId` + `messageId`; authoritative `message.completed` replaces transient content. No promise of every delta after disconnect.

## 4. MCP contracts

Backend exposes one protected **Streamable HTTP** endpoint at `/mcp` with seven tools (`yield_task` added by T05 decision — the original six had no explicit parent-wait signal):

| Tool | External agent | Managed agent |
|---|---|---|
| `list_tasks` | Authorized user-selected scopes | Restricted to current task/children |
| `get_task` | Authorized scopes | Current task, allowed parent/children |
| `create_task` | Authorized scopes | Only child of current task; limits apply (depth 0 only, max 5 children) |
| `get_messages` | Authorized scopes | Task conversation only |
| `post_message` | Authorized scopes | Scoped current task only |
| `request_input` | Authorized scopes | Scoped current run only; structured HITL |
| `yield_task` | Not applicable (managed-only) | `{ childTaskIds?: string[], reason?: string }`; requires verified process-tree stop; scoped to current task's own children |

External MCP clients must be explicitly paired/authorized (one-time pairing code approved via Settings); managed clients receive short-lived run-scoped credentials that auto-expire at finalize. Do not expose raw SQL, execution claim, arbitrary file operations, or administrative process actions through MCP. MCP tools call the exact same backend domain services as REST. Use origin/host protections and authentication on localhost (§8.1).

**Transport distinction:** MCP over HTTP is a *tool protocol*. Backend UI SSE is an *application notification channel*. Adapter-to-engine SSE is a *run telemetry stream*. These are independent contracts even if all use streaming HTTP.

## 5. State transition contract

| From | To | Trigger / guard |
|---|---|---|
| `todo` | `processing` | Backend grants atomic claim + working-tree lock |
| `todo` | `cancelled` | User cancel, no active writer |
| `processing` | `done` | Owner run verifies successful terminal event + policy checks |
| `processing` | `error` | Owner run fails; process stopped/verified |
| `processing` | `hitl` | Structured input request; paused agent state recorded, lock policy explicit |
| `processing` | `todo` | Parent yields for children; process verified stopped; blocked reason set |
| `processing` | `cancelled` | Cancel request acknowledged, process stopped |
| `hitl` | `todo` | User answers; resumable or new agent turn can be safely queued |
| `hitl` | `processing` | Only when actively resuming **same retained paused process** under same lock; no second writer |
| `hitl` | `cancelled` | Cancel and terminate retained process if any |
| `error` | `todo` | Explicit retry + no existing live writer |

Terminal `done` and `cancelled` do not re-enter queue implicitly and have **no** transition back into the queue — no endpoint exists for it. **Only `error` has a retry path** (T05 decision, explicit): `POST /tasks/:id/retry` creates a brand-new `runId`, increments the working-tree lock `generation`, and performs a fresh atomic claim; rejected if the prior run is not verified-stopped (guaranteed already, since only a finalized `error` run reaches this state, per §3 `finalize`'s `verifiedStopped` requirement). `needs_review` is represented by `hitl` only when input is required; completed work requiring optional human inspection stays `done` and its message says review is suggested. **Do not auto-approve provider tool permissions just to maintain zero-click UX.**

## 6. Storage contract

**Single SQLite DB managed by backend**, using separate domain folders and migrations:

- Task domain: `repositories`, `tasks`, `runs`, `run_locks`, optionally `run_event_receipts` for deduplication.
- Chat domain: `conversations`, `messages`.
- `tasks.conversation_id` links domains, backed by FK; application boundaries remain independent.
- Suggested uniques/indexes: `repositories(canonical_path)`, `tasks(status,priority,created_at)`, `tasks(parent_id)`, `runs(task_id,started_at)`, `messages(conversation_id,created_at,id)`, `run_locks(working_tree_key)`, `run_event_receipts(run_id,sequence)`, `tasks(origin_run_id,idempotency_key)` where present.
- `runs`: provider, owner/fencing generation (`ownerId`/`generation` wire fields bind to `owner_token`/`lock_generation` columns), provider session ID, process metadata, recovery state (`uncertain` is a valid internal `status` value, distinct from public task state), exit code, log location, started/ended timestamps.
- `tasks`: adds `depth` (0 for root, `parent.depth+1` for children) and `blocked_on_child_ids` (nullable JSON array, set by `yield_task`, cleared when all listed children reach a terminal state) — T05 decision, see ARCHITECTURE.md §4/§8.
- Raw logs stored in OS-appropriate application data directory. Do not expose arbitrary filesystem paths to browsers via static serving.

## 7. Error handling and event transport

- Adapter streams normalized events to engine using SSE; engine sends reliable semantic events to backend via authenticated POST. It can coalesce deltas (e.g. 50–100 ms UI batches) but must not delay control transitions.
- Backend transactionally stores durable state; **after commit**, publish to in-memory event hub; hub fan-outs to browser SSE connections.
- Slow browser subscriber: bounded per-client memory; close and force REST reconciliation rather than buffering indefinitely.
- If engine POST times out, retry idempotently with the identical `(runId,sequence,type,data)` tuple and verify backend receipt (§3 event-hash dedup).
- If adapter restarts mid-run, or the engine cannot otherwise prove a terminal event or process-tree absence, call `POST /internal/v1/runs/:id/mark-uncertain` to **quarantine the uncertain run/lock**; clearance requires verified process-tree termination or an explicit `POST /internal/v1/runs/:id/clear-quarantine` admin override. Do not free lock solely because heartbeat expired.
- External caller failures use conventional 400/401/403/404/409/422/5xx and typed error bodies `{code,message,details?}`; no stack trace or secrets in public payload.

## 8. Cross-platform and distribution contract

- Delivery order is macOS first for M0–M5; Linux/Windows acceptance is required at T31/M6 before cross-OS release. Their deferred verification does not block M1 and does not count as passed support.
- Ship **one TaskAside npm package** containing Node-compatible launcher, Bun application bundles, Vite assets, and dependency on appropriate upstream Bun runtime distribution.
- `npx taskaside` requires Node/npm; `bunx taskaside` requires Bun. One package ≠ one OS-neutral native executable.
- Launcher installs/copies a **stable runnable payload** into the user's app-data directory; do not depend on ephemeral npx cache lifetime for a detached process.
- A persistent **supervisor process** starts three child CMDs: `backend`, `agent-adapter`, `execution-engine` in dependency order. `status`/`stop` commands target the same single instance. Health checks and guarded restart policy are required.
- Default listeners bind to `127.0.0.1`. Internal ports should be dynamically chosen or conflict-checked, shared only through supervisor-controlled config. Browser binds no public port.
- OS-appropriate data paths: macOS `~/Library/Application Support/TaskAside`, Linux `${XDG_DATA_HOME:-~/.local/share}/taskaside`, Windows `%LOCALAPPDATA%\\TaskAside` (subject to available path libraries).
- Test Windows handle/creation flags, process termination, path canonicalization and file permissions; don't assume POSIX behavior on Windows.

### 8.1 Local auth and service roles (T05 decision)

- Every listener (public REST/SSE, internal REST, MCP) binds `127.0.0.1` only and rejects requests whose `Host`/`Origin` is not exactly `127.0.0.1:<port>` or `localhost:<port>` for that service's own port.
- **Six service roles:** `supervisor`, `engine`, `adapter`, `browser`, `mcp-managed`, `mcp-external`.
- Supervisor generates `auth.token` (256-bit random, `chmod 0600`, app-data directory) at first run. `taskaside start` opens the browser at `http://127.0.0.1:<port>/?token=<token>`; the frontend reads it once, stores it in `sessionStorage`, strips it from the visible URL, and sends `Authorization: Bearer <token>` on REST calls. SSE accepts the same token as `?token=` (no custom headers in `EventSource`).
- Supervisor also generates a separate `internal.token` (0600), passed to `backend`/`execution-engine`/`agent-adapter` via environment at spawn. Every `/internal/v1/*` call requires `X-TaskAside-Role: engine|adapter|supervisor` **and** `Authorization: Bearer <internal.token>`. Browser tokens cannot authorize internal routes and vice versa.
- External MCP clients pair explicitly: an unrecognized `/mcp` caller gets `401` plus a one-time pairing code, approved from the Settings modal, minting a revocable scope-limited bearer token. `mcp-managed` tokens are minted per run, scoped to `taskId`/`runId`, and auto-expire at finalize — never user-approved.

## 9. Required test matrix

| Case | Expected outcome |
|---|---|
| Same working tree: P1 + P0 | Only one active writer; P0 claimed first if both waiting |
| Different registered repos | Parallel execution up to global concurrency |
| Codex and Claude | Both support end-to-end start/event/complete/cancel; capability gaps surfaced |
| Browser reconnect during streaming | Persisted conversation/status restored; transient deltas may be lost safely |
| Duplicate `message.completed` event | Exactly one persisted message |
| Child task MCP create retried | Exactly one child created via idempotency key |
| HITL request and answer | Correct task/message state and safe resume semantics |
| Adapter/engine daemon crash | No duplicate writer; manual recovery path when uncertain |
| Cancel during write | Process tree stops before working-tree lock release |
| Cross-origin malicious local request | Blocked, even though destination is localhost |
| npm package on three OSes | One command launches installed background processes and browser |
| Duplicate event with different payload at same sequence | `409 SEQUENCE_CONFLICT`, no partial apply |
| Stale `ownerId`/`generation` on any of claim/heartbeat/events/finalize/input/cancel | `409 STALE_GENERATION`, no state mutation |
| `finalize` called with `verifiedStopped:false` | Rejected; run does not reach `done`/`error`/`cancelled` |
| Duplicate HITL reply (same/stale `inReplyToRequestId`) | `409 REQUEST_ALREADY_RESOLVED`, no second resume |
| `yield_task` beyond depth/count limits | Rejected; no child created, no grandchild depth reachable |
| Request with wrong/missing `Authorization`/role header on internal or MCP route | `401`/`403`, no state mutation |

## 10. Open POC gates (not settled by this spec)

Resolved by [T05](evidence/T05-feasibility-and-contract-gaps.md): event envelope shape, owner/fencing field names and verified-stop-before-release rule, uncertain/quarantine trigger and clearance endpoints, HITL pending-request atomicity and duplicate-reply rejection, the `yield_task` MCP tool and fixed child depth/count limits, and the local auth token/role contract. Still open, explicitly POC-gated, not settled by this spec:

- Exact Codex App Server client protocol/schema and approval event handling (experimental upstream tag per T01 §7).
- Codex `exec resume <thread-id>` end-to-end verification (contract-shaped in T05 §4, not yet exercised).
- True mid-turn, process-retained HITL pause/resume for either provider (both T01 and T02 only proved stop-and-resume, not a held-open paused process).
- Reliable detached supervisor lifetime and process-tree cleanup on Windows/Linux (macOS verified in T03/T04; Windows/Linux remain T31 gates).

Do not claim full production support until these tests pass; record evidence in [PLAN.MD](PLAN.MD).
