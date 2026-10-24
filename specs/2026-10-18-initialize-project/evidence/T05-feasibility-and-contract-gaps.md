# T05 — Feasibility synthesis and contract-gap decisions

**Date:** 2026-10-18
**Inputs:** [T01-codex-lifecycle.md](T01-codex-lifecycle.md), [T02-claude-lifecycle.md](T02-claude-lifecycle.md), [T03-stable-bootstrap.md](T03-stable-bootstrap.md), [T04-process-and-repo-identity.md](T04-process-and-repo-identity.md)
**Disposition:** M0 passes on macOS for both providers' baseline lifecycle, the one-package bootstrap, and process/repo-identity safety. Codex MCP/fine-grained-HITL and Claude mid-turn process-retained HITL remain explicitly unverified and capability-gated, not blocking. No M0 finding invalidates the documented architecture; six contract gaps below are now closed so M1 can start from one unambiguous contract.

This record is the single source for *why* each decision was made. [SPECIFICATION.md](../SPECIFICATION.md) and [ARCHITECTURE.md](../../ARCHITECTURE.md) are updated to match; where this record and those documents could ever disagree later, the documents govern behavior and this record stays as rationale history.

## 1. One event envelope

**Conflict:** SPECIFICATION.md §3 showed a flat envelope (`type` + `data` at the top level); ARCHITECTURE.md §6 showed a nested `EventEnvelope { event: AgentEvent }`.

**Decision:** Flat envelope wins — it is simpler to validate and matches both providers' own JSONL shape (T01/T02 both stream one typed line at a time; neither nests "event" inside another envelope object).

```json
{
  "runId": "run_01",
  "sequence": 42,
  "type": "message.completed",
  "timestamp": "2026-10-18T09:00:00Z",
  "data": { "messageId": "msg_01", "content": "Implemented login validation." }
}
```

- `type` is one of: `message.delta`, `message.completed`, `input_required`, `completed`, `failed`, `cancelled`.
- `data` shape is discriminated by `type` (see ARCHITECTURE.md §6 for the per-type payload). Validation is a Zod discriminated union keyed on `type`; the envelope fields (`runId`, `sequence`, `type`, `timestamp`) are required regardless of `type`.
- **Sequencing:** `sequence` is a strictly increasing integer **per `runId`**, starting at 1. Persistent types (`message.completed`, `input_required`, `completed`, `failed`, `cancelled`) are deduplicated by `(runId, sequence)`; `message.delta` is transient and is not required to be gap-free or persisted.
- **Duplicate/conflict handling:** backend computes `event_hash = sha256(canonical_json({runId, sequence, type, data}))` and stores it in `run_event_receipts` keyed by `(run_id, sequence)`.
  - No existing receipt → insert, apply the side effect, return `200` (ACK).
  - Existing receipt, same `event_hash` → return `200` (ACK), do **not** re-apply the side effect (idempotent replay).
  - Existing receipt, different `event_hash` for the same `sequence` → return `409 Conflict` with `{code:"SEQUENCE_CONFLICT"}`.

**Why flat:** nesting added no information the flat shape couldn't carry, and every provider fixture in T01/T02 is already a single typed JSON object per line — mapping that into a flat envelope is a direct 1:1 translation with less code.

## 2. Owner and stop proof

**Gap:** architecture said "owner and fencing generation" are required but did not name the wire fields or specify which endpoints carry them; it also did not say how "turn completion" differs from "safe to release the lock."

**Decision:**

- Every internal endpoint that mutates run/lock state — `claim`, `heartbeat`, `events`, `finalize`, `input`, `cancel` — carries two body fields:
  - `ownerId` (string): the identifier of the **active execution-engine instance** that currently holds the claim. Generated once per engine process lifetime (ULID), not per request.
  - `generation` (integer): the fencing generation for the working-tree lock, assigned at `claim` and incremented on every re-claim (including retry-after-error). Monotonic per `run_locks.working_tree_key`.
- Backend validates `runs.owner_token == ownerId AND run_locks.generation == generation` on every one of those six calls. Mismatch → `409 Conflict {code:"STALE_GENERATION"}`; the caller must not retry blindly — it must re-fetch run state first.
- **Turn completion ≠ lock release.** T01 and T04 both showed that a process exiting cleanly (`turn.completed`, provider `stop`/`result` event, or exit code 0) says nothing about descendant processes (T04 §1a: a naive top-level kill left two live reparented descendants). Therefore:
  - `POST /internal/v1/runs/:id/finalize` requires an explicit `verifiedStopped: boolean` and `verificationMethod: "process_group_empty" | "ps_fingerprint_absent"` field, populated by the adapter's process-tree check (T04 §1b/§2 method: `kill(-pgid, SIGTERM)` escalate to `SIGKILL`, confirm via `ps -p` / fingerprint absence).
  - Backend **rejects** `finalize` transitions to `done`/`error`/`cancelled` with `verifiedStopped:false` — those calls instead route through `mark-uncertain` (§3 below). A terminal DB status is never written on turn-completion alone.
  - Lease/heartbeat expiry alone never authorizes lock release (reaffirms CONSTITUTION.md IV.3); it only triggers reconciliation.

## 3. Durable event gaps and recovery

**Gap:** spec said lost ACKs are retried and uncertain runs are quarantined, but did not pin exact retry identity or the exact uncertain-transition trigger/endpoint contract.

**Decision:**

- Persistent event types are buffered by the engine until it receives a `200` ACK from `POST /internal/v1/runs/:id/events`. On ACK loss (timeout, connection drop), the engine retries the **identical** `(runId, sequence, type, data)` tuple — the resulting `event_hash` is identical, so the dedup rule in §1 makes the retry a no-op if the first attempt actually landed.
- If the engine loses the adapter stream/process and `GET /internal/v1/runs/:id` (adapter) cannot prove either a terminal event was emitted or the full process tree is gone, the engine calls `POST /internal/v1/runs/:id/mark-uncertain` with `{ownerId, generation, reason}`.
- Effect: `runs.status = "uncertain"`; `run_locks` row moves to `quarantined` (reusing the state machine already verified in T04 §4: `held → quarantined → released`). The **public** task status stays whatever it last was (`processing` typically) with `blockedReason` set to a human-readable "run state unverified" message — never silently advanced to `done`.
- Quarantine clears only two ways (T04 §4, both already proven): verified termination (adapter-confirmed empty process group) or an explicit administrative override call, `POST /internal/v1/runs/:id/clear-quarantine`, requiring the `supervisor` role and recorded operator identity. No automatic timer-based clearance exists.
- Backend never invents a successful completion from silence — absence of evidence is treated as absence of proof, consistent with CONSTITUTION.md IV.5.

## 4. HITL (human-in-the-loop)

**Gap:** the pending-request/reply pairing was described in prose but not as an atomic operation; duplicate-reply and unsupported-input behavior were undefined; both T01 and T02 found neither CLI demonstrates true mid-turn process-retained pause.

**Decision:**

- Adapter emits `input_required` with `data: {requestId, question}` (`requestId` is a UUID minted by the adapter). Engine forwards this as a normal event via `POST /internal/v1/runs/:id/events`.
- Backend's event-ingestion transaction for `input_required` is atomic: persist the question as an agent message, set `tasks.status = "hitl"`, set `runs.pending_request_id = requestId`. All three happen in one SQLite transaction or none do.
- User reply: `POST /api/conversations/:id/messages` accepts an optional `inReplyToRequestId`. Backend transaction: if `tasks.status == "hitl"` and `runs.pending_request_id == inReplyToRequestId`, insert the user message, clear `pending_request_id`, set `tasks.status = "processing"`. The engine then dispatches a resume per capability (below).
- **Duplicate replies are rejected idempotently:** a second `POST` carrying the same (now-cleared or mismatched) `inReplyToRequestId` returns `409 {code:"REQUEST_ALREADY_RESOLVED"}` and performs no second resume. The client must treat this as "already handled," not as a hard failure requiring user action.
- **Unsupported live input:** neither provider demonstrated a process that can receive input on a held-open stdin mid-turn (T01 §9/§11, T02 §10/§11 both explicitly mark this unverified). MVP therefore always treats a turn as stopped once `input_required` is observed:
  - Adapter stops the turn safely (process exits) after emitting `input_required`; the working-tree lock is **retained** through `hitl` (per ARCHITECTURE.md §8 — another run must not edit the tree) even though no process is alive.
  - On reply, the engine resumes by provider capability: **Claude** uses `--resume <session-id>` (verified end-to-end in T02 §10 across separate processes) with the reply as the new turn's prompt. **Codex** uses the `exec resume <thread-id>` subcommand surfaced in `--help` (T01 §8/§10); this path is contract-shaped now but **not yet end-to-end verified** — `GET /capabilities` must report `resume: true|false` honestly per provider/version, and the engine must not silently fall back to a second concurrent writer if resume is unsupported; it queues the reply and keeps the task in `hitl` until a human-visible fallback (fresh turn with reply folded into instruction context, explicitly flagged in chat as "continued in a new turn") is taken.
- **Explicit rule:** a chat reply is always ordinary turn content. It is never mapped to a provider's own approval/permission-prompt channel (Codex `app-server`'s `ExecCommandApprovalParams`/etc., or Claude's `--permission-prompts`). MVP drivers use blanket auto-approval profiles (`--approve-for-me` / `--permission-mode acceptEdits`); per-action approval wiring is out of scope until a dedicated POC, consistent with CONSTITUTION.md IV.6.

## 5. Parent yield and child tasks

**Gap:** architecture mentioned "parent yields using explicit structured signal" but the six MCP tools had no such tool; child wait/limit numbers were inconsistent (SPECIFICATION.md defaulted `maxDepth=3`/`maxChildrenPerTask=10`, task guidance for T05 fixes `max depth 2`/`max 5 children`).

**Decision:**

- Add a **7th MCP tool**, `yield_task`, params `{ childTaskIds?: string[], reason?: string }`. If `childTaskIds` is omitted, it defaults to all currently non-terminal children of the calling task.
- Calling `yield_task` requires the same verified-stop proof as §2: the engine confirms the parent's process tree is fully stopped (or, if a future driver supports true suspension, confirmed suspended) before the transition commits. On success: `tasks.status = "todo"`, `blockKind = "children"`, `blockedReason` set to a human-readable summary, and the working-tree lock is released (processing → todo already requires "process verified stopped" per the existing state table).
- Engine tracks the wait set via a new column, `tasks.blocked_on_child_ids` (nullable JSON array of child task IDs), set at `yield_task` time — **not** a new generic workflow table; this is a bounded array on the existing row.
- When every ID in `blocked_on_child_ids` reaches a terminal state (`done`, `error`, `cancelled`), the engine clears the wait and schedules a **new claim** for the parent (a new `runId`; the old run already finalized at yield time). The new run's instruction context includes a structured summary per child: `{childTaskId, status, summary}`.
- If any child is `error` or `cancelled`, the parent's resumption context includes a structured error list for those children; the parent is not auto-retried and does not auto-spawn replacement children (reaffirms CONSTITUTION.md VII.4 and SPECIFICATION.md E-02).
- **Strict limits (fixed, replacing the old configurable `maxDepth=3`/`maxChildrenPerTask=10` defaults):** `depth(root) = 0`, `depth(child) = parent.depth + 1`. `create_task` via MCP is only permitted when the calling task's own `depth == 0` (so a child, at `depth 1`, cannot itself create a grandchild at `depth 2`) — this is the "max depth 2" / "no grandchildren" rule expressed as two allowed levels. Each task may have at most **5** children. Both are hard MVP ceilings, not tunable upward via settings.

## 6. Local auth and service roles

**Gap:** architecture asserted loopback binding and Host/Origin checks but did not define the browser bootstrap token flow, the internal inter-service credential, or the external MCP pairing mechanism; retry/reopen rules for terminal states needed to be pinned down explicitly.

**Decision:**

- **Loopback + Host/Origin:** every HTTP listener (public REST/SSE, internal REST, MCP) binds `127.0.0.1` only and rejects requests whose `Host`/`Origin` header is not exactly `127.0.0.1:<port>` or `localhost:<port>` for that service's own port. This closes the DNS-rebinding/browser-origin gap ARCHITECTURE.md §3 already flagged as insufficient with loopback binding alone.
- **Browser bootstrap token:** supervisor generates a random 256-bit `auth.token` file in the OS app-data directory at first run, `chmod 0600`, reused across restarts (rotated only by explicit user action, out of MVP scope to automate). `taskaside start` opens the browser at `http://127.0.0.1:<port>/?token=<token>`. The frontend reads the query-string token once, stores it in `sessionStorage` (not `localStorage`, to bound lifetime to the tab), strips it from the visible URL, and sends `Authorization: Bearer <token>` on every REST call. The SSE endpoint (`EventSource` cannot set custom headers) accepts the same token as a `?token=` query parameter, validated identically to the header form.
- **Service roles:** exactly six — `supervisor`, `engine`, `adapter`, `browser`, `mcp-managed`, `mcp-external`.
- **Internal inter-process credential:** separate from the browser token. Supervisor also generates `internal.token` (0600) and passes it to `backend`, `execution-engine`, and `agent-adapter` at spawn (env var, never written to a world-readable config or logged). Every internal call (`/internal/v1/*` on backend and adapter) requires both `X-TaskAside-Role: engine|adapter|supervisor` and `Authorization: Bearer <internal.token>`. A caller with a browser token cannot access internal routes and vice versa.
- **External MCP pairing:** an external client calling `/mcp` without a recognized bearer token gets `401` plus a one-time pairing code; the user approves the code from the Settings modal (avatar → Settings, no new top-level surface, per CONSTITUTION.md V.4); approval mints a scoped, revocable bearer token for that client with an explicit tool/scope allowlist (subset of the 7 MCP tools). `mcp-managed` tokens are different: short-lived, minted by the backend for the engine/adapter to hand to a spawned provider process, scoped to exactly `taskId`/`runId`, and auto-expire at run finalize — never user-approved, never reused across runs.
- **Terminal-state rule (explicit):** `done` and `cancelled` never accept any transition back into the queue — no endpoint exists for it. Only `error` has a retry path: `POST /tasks/:id/retry` creates a brand-new `runId`, increments the working-tree lock `generation`, and performs a fresh atomic claim; it is rejected if the prior run is not verified-stopped (which is already guaranteed, since only a finalized `error` run reaches this state per §2).

## Outstanding, explicitly not closed by this record

- Codex `exec resume <thread-id>` end-to-end behavior (§4) — contract-shaped, not verified; T17 must run a dedicated POC before the Codex driver can claim `resume: true`.
- True mid-turn, process-retained HITL for either provider — still unverified per T01/T02; MVP uses the stop-and-resume model in §4 exclusively.
- Linux/Windows versions of every mechanism in §2 (process-tree verification) and §6 (token file permissions, path layout) — explicitly deferred to T31 per T03/T04, not re-litigated here.

## M0 exit criteria check

| Criterion (PLAN.MD T05 gate) | Status |
|---|---|
| T01–T04 pass on macOS | Yes — see each evidence file's recorded results |
| Baseline start/stream/terminal/cancel works for both installed CLIs | Yes (T01 §3–§6, T02 §3–§6) |
| Optional capability gaps have a safe documented path or stay blocked | Yes — MCP/fine HITL (Codex), mid-turn retained HITL (both), Codex resume (this record §4/§5) are explicit capability flags, not silent assumptions |
| One event envelope, owner/fencing fields, durable-recovery rule, HITL pairing, parent-yield tool, and local auth/roles are each defined once and consistently | Yes — §1–§6 above, mirrored into SPECIFICATION.md and ARCHITECTURE.md in this same change |
| Linux/Windows verification is not claimed as passed | Correct — all four evidence files explicitly defer those to T31 |

**M0 gate: pass.** M1 (T06–T09) may start from the contracts as now unified.
