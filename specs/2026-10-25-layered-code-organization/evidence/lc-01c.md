# Evidence: LC-01c — Record UI and lifecycle baseline

## Outcome
Baseline UI, headless browser, workflow, engine, adapter, supervisor, and distribution suites executed and recorded. All interactive UI, live SSE reconnection, worker pool occupancy (8-slot limit, single-writer per repo), graceful shutdown, crash recovery/uncertain quarantine, and distribution packaging checks passed with zero failures on disposable environments.

## Affected Owners / Files
- `src/frontend/`
- `src/execution-engine/`
- `src/agent-adapter/`
- `src/supervisor/`
- `src/distribution/`
- `bin/taskaside.js`
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-01c.md`

## Executed Checks and Results
1. `bun run test:ui`: Passed (Grouping, preferences persistence, API/UI integration, conversation/HITL/SSE, strict boundaries)
2. `bun run test:workflow`: 10/10 passed (Live user workflow: Codex, Claude, HITL reply, child tasks, nested grouping, settings modal, browser close/reopen, SSE disconnect/reconnect)
3. `bun run test:browser`: 11/11 passed (Native CDP headless Chrome: DOM mount, token sanitization, task header binding, Markdown sanitization, composer, stream scoping, cursor pagination, responsive mobile 375px/tablet 768px/desktop 1440px, dark theme, ARIA roles)
4. `bun run test:harness`: 11/11 passed (Integration lifecycle, event dedup, sequence conflicts, lost ACK, HITL pause/resume, quarantine safety)
5. `bun run test:engine`: 53/53 passed (Scheduler priority P0-P3, one-per-tree hold, 8-slot limit, instruction builder, event forwarder, cancel/reconciliation, HITL pause/resume, parent-child delegation)
6. `bun run test:startup`: 5/5 passed (Startup reconciliation without second writer, live task cancellation waiting for verified stop)
7. `bun run test:pool`: 14/14 passed (P1–P14: admission spacing >= 100ms, peak occupancy 8/8, canonical path alias serialization, engine contention, non-stalling, stream isolation, durable receipts, 60min deadline, quarantine safety, fencing, graceful shutdown, backoff, upgrade compatibility, live CLI smoke)
8. `bun run test:adapter`: 14/14 passed (Health, capabilities, single-spawn, monotonic SSE, status, cancel verified stop)
9. `bun run test:safety`: 11/11 passed (Token redaction, log rotation, slow consumer disconnect, process tree SIGTERM/SIGKILL, fencing)
10. `bun run test:services`: 19/19 passed (Service startup order backend -> adapter -> engine, 0600 token permissions, Host/Origin headers, internal role auth)
11. `bun run test:supervisor`: 5/5 passed (Hardened lifecycle, attach-once lock, status, clean termination, clean restart)
12. `bun run test:distribution`: 8/8 passed (Vite + Bun build, npm pack filter, launcher resolution, payload installation, detached supervisor survives ephemeral npx cache purge)

Total: 161+ checks passed, 0 failed.

## Lifecycle & Interaction Baseline Findings

### 1. UI & Browser Interactions
- Task switching updates conversation bindings without leaking transient events across tasks.
- Token passed in URL is stripped from browser URL bar and stored into `sessionStorage`.
- HTML tags inside Markdown are strictly sanitized; remote image URLs are blocked by default.
- Paging uses TanStack Query infinite query with forward cursors.

### 2. Concurrency & Single Writer
- Max 8 concurrent active workers globally (`MAX_WORKERS = 8`).
- Strict single active writer per canonical repository path. Multiple tasks targeting the same repository or alias are strictly serialized.
- Busy repo does not stall tasks on idle repos.

### 3. Fencing, Cancellation, and Verified Stop
- Cancellation of a processing task sends cancel intent, signals process group, and waits for `verifiedStopped: true` with proof (`process_group_empty`) before finalizing run and releasing repository lock.
- Unverified stop immediately sets the run status to `uncertain` and quarantines the canonical repository lock.
- Quarantined locks cannot be acquired by any engine or retry request until explicitly cleared by supervisor.
- Lease/heartbeat expiration alone NEVER releases locks.

### 4. Supervisor & Distribution
- Starts in order: `backend` -> `agent-adapter` -> `execution-engine`.
- Lock file prevents duplicate supervisor instances.
- Launcher `bin/taskaside.js` copies payload to `TASKASIDE_DATA_DIR/payload` so that clearing ephemeral npx cache does not disrupt running daemon.

## Limitations & Environment Notes
- Executed on native macOS (Darwin arm64).
- Headless Chrome ran via `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Native Linux and Windows environments are not available on this host and remain deferred to LC-12d / LC-12e.

## Rollback
Documentation-only task; no code changes. Rollback is deleting this evidence file.

## Next Task
LC-02a: Pilot settings layers.
