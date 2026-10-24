# Polling scheduler with eight execution slots

## TL;DR
- **Goal:** Run eight independent tasks asynchronously, with one writer per canonical absolute local repository path.
- **Key decision:** Use a Promise pool; atomically claim task, repository, and capacity through the existing backend/SQLite authority.
- **Impact:** Engine scheduling/lifecycle, internal run contracts, adapter deadlines, and additive persistence. Public task states stay unchanged.

## One pool, one task per slot

```mermaid
flowchart LR
    S[Scheduler every 100ms] --> F{Free slot?}
    F -->|No| K[Skip task query]
    F -->|Yes| C[Atomic eligible claim]
    C --> P[Pool of up to 8 slots]
    P --> H[Adapter runs harness]
    H --> V[Verify stop and finalize]
```

## Contract changes

- **Internal claim:** Atomically return the selected task/run, canonical repo path, fencing generation, and deadline. Existing claim routes enforce the same ownership/capacity guards.
- **Internal start/status:** Carry the run deadline to the adapter. Resumption/retries never extend it; timeout has a distinct failure reason.
- **Public API:** Preserve routes, task statuses, priority, and manual retry. Existing `maxConcurrency` values remain accepted; effective capacity is capped at eight. New installations default to eight; existing settings are preserved.

## Scope

### In scope

| Item | Readiness | Observable outcome |
|---|---|---|
| Promise pool and cadence | **Ready** | At most eight owned attempts; at most one new dispatch per 100ms scheduler tick; no overlapping ticks. |
| Repository synchronization | **Ready** | Absolute local folder identity with alias normalization. Different canonical paths may run concurrently. |
| Atomic admission | **Ready** | Shared backend prevents duplicate task claims, repo owners, and capacity overflow across engine processes. |
| Timeout | **Ready** | Each attempt has a 60-minute deadline, retained across restart. |
| Recovery and shutdown | **Ready** | Stop verification governs release; uncertain writers remain reserved/quarantined. |
| FIFO and timeout details | **Assumption — review** | Preserve enqueue-time FIFO and manual retry. Count HITL within the deadline; please review this default. |

### Out of scope

- Worker Threads, database connection pools, Redis/distributed locks, remote hosts, cross-path Git identity, automatic task retries, new harness drivers, and unrelated UI/business changes.
- Concurrent implementation alongside the earlier handoff repair. Integrate after that work is reviewed; do not duplicate or overwrite it.

## Review decisions

| Decision | Why / trade-off |
|---|---|
| Eight logical slots, no worker threads | Engine work waits for HTTP/SSE/subprocesses; no measured need for CPU parallelism. |
| One backend authority | Reuse current SQLite locks/fencing. Separate databases cannot protect the same folder. |
| One admission per tick | Meets requested pacing; limits ideal dispatch rate to ten attempts/second per scheduler. |
| Reserve during HITL/uncertainty | Prevent capacity reuse while an old writer may remain. Safety can reduce available throughput. |

## Behavior

- **Admission:** With free capacity, select P0–P3, enqueue time ascending, then task ID. Exclude blocked tasks and every path already reserved/quarantined, regardless of public task status. Never preempt running work.
- **Atomicity:** Eligible selection, task validation, capacity check, run creation, and repo reservation commit together. Local memory only caches occupancy; failed/unknown requests cannot authorize another writer.
- **Async execution:** Each slot owns one attempt and isolated stream state. Scheduler, heartbeat, cancel, and recovery continue while execution or HITL continuation is pending. No unbounded local task queue.
- **Timeout:** Sixty minutes from successful claim, including setup and HITL. Request process-tree termination; only verified exit permits `error` finalization with timeout reason. Missing proof retains ownership/quarantine, never silent success.
- **Completion:** Verified completion/failure/cancellation releases both capacity and repo once. Yield follows the earlier repair: durable intent, verified stop, then release. Manual retry creates a new attempt/deadline and rejoins FIFO.
- **Recovery:** Reconcile durable reservations before admission. Lost heartbeat/lease expiry triggers inspection, never automatic release. Expired attempts cannot restart a harness; unknown processes remain blocked for safe recovery.
- **Shutdown:** Stop admission immediately, drain for 30 seconds, then request bounded termination. Finalize verified exits; durably quarantine unresolved attempts before stopping, or retain their existing reservations if the backend is unreachable.

## Impact

- Preserve backend state ownership, engine policy, adapter process ownership, and the three-service architecture.
- Add durable deadline/admission receipts as needed; preserve existing runs, generations, yields, and uncertain locks.
- Short indexed claims replace full-backlog polling. Synchronous SQLite work must remain bounded and outside long-running network/process waits.

## Advanced

### Confirmed choices and operating boundary

- **Lock by canonical absolute local folder path.** A remote URL, Git repository name, branch, and `.git` common directory are not lock identities.
- Use existing canonicalization: absolute path, realpath/symlink resolution, existing Git-root normalization, and case normalization where the filesystem is case-insensitive. Do not lowercase paths on case-sensitive filesystems. Preserve a real usable cwd separately if identity normalization changes its spelling.
- One logical execution pool serves one TaskAside installation/backend. It has up to eight reusable slots; each slot dispatches one task to one supported harness and watches that attempt. There is no nested pool per repo or provider.
- Multiple engine processes against the same backend must share the capacity ceiling and path locks. Normal operation remains one scheduler. The one-admission-per-tick limit is per scheduler; adding a cluster-wide dispatch rate limiter is outside scope.
- Independent backends/databases pointed at the same folder are not coordinated. Do not claim filesystem exclusivity against external tools or separate installations. Retain the earlier read-only planner operating boundary.
- Initial implementation targets the existing Bun runtime. Promise-based engine orchestration does not make the backend's `bun:sqlite` persistence portable to Node.js.

### Polling and bounded work

| Setting | Meaning |
|---|---|
| `MAX_WORKERS = 8` | Hard upper bound shared by engines using this backend. |
| `POLL_INTERVAL = 100ms` | Target scheduling cadence, not a real-time deadline. |
| `TASK_TIMEOUT = 60min` | Elapsed time from durable claim, including HITL; one deadline per attempt. |
| Heartbeat / lease | Retain the existing 5s heartbeat and 30s lease. Expiry never transfers ownership. |
| Shutdown drain | 30s, followed by bounded adapter termination/escalation and reconciliation. |

The effective limit is `min(configured maxConcurrency, 8)`. Preserve an existing lower setting; values 9/10 remain API-compatible but execute with a ceiling of eight, disclosed in operational diagnostics/logs and existing settings help. Do not rewrite historical migrations or silently change old configured values. Reducing capacity stops admissions until occupancy falls below the new limit; never kills existing work to match a lower setting.

Use one non-overlapping scheduler cycle. Slow cycles skip missed ticks; they do not accumulate timer callbacks or dispatch catch-up bursts. At most one new admission/start is initiated per tick. Resume/start actions remain subject to a single live harness per attempt and the same occupancy rules; resuming a reserved HITL attempt does not claim another slot. Worker completion may mark a slot available but cannot bypass the next admission tick.

Reuse slot records and service HTTP clients. Bound per-attempt SSE/event buffers; retire timers, stream readers, and event listeners when monitoring ends. Reusing a slot must not reuse an old attempt's sequence cursor, pending delta, cancellation state, or timeout. Harness processes remain adapter-owned and are not shared across unrelated tasks merely to keep a slot warm.

When full, do not query new runnable tasks or issue claims. Heartbeats and a bounded active-run control feed remain allowed. Refresh settings and control state on a separate bounded cadence, proposed at most once per second, rather than per-task status requests on every 100ms tick. SSE forwarding remains event-driven. No task execution, HITL continuation, or slow termination is awaited on the scheduler's critical path.

Keep HTTP control requests bounded by a 5s request timeout; do not apply that as a total lifetime limit to SSE streams. Transport failures trigger capped exponential backoff (250ms to 5s, with jitter), allowing scheduler ticks to skip admission while a backend is unavailable. Only one admission request may be outstanding per scheduler. Do not create a local queue of waiting admission promises.

### Atomic admission, ownership, and lost acknowledgments

The engine owns scheduling policy and supplies the admission request. The backend applies the fixed priority/FIFO policy inside a short SQLite write transaction, for example `BEGIN IMMEDIATE`; it is the only SQLite accessor. Do not move subprocess launch, prompt assembly, or scheduling timers into the backend.

The transaction must encompass all reads that authorize the write: eligible task/path, current owner/quarantine, and shared capacity, plus run creation and reservation. Preserve unique path ownership and fencing; route all existing claim paths through these guards so a direct claim cannot bypass pool capacity. Do not use an unconditional lock upsert to replace a live owner.

Persist successful admission idempotency under engine identity plus request key. A repeated successful request returns the same admission; changed request reuse conflicts. Empty polls must not write receipts: no work means no reservation was committed, and retrying that key may admit work later, at most once. Start a fresh tick/key only after the outstanding request is resolved. Resolve a lost claim/start acknowledgment by the original identity/key/run, never by blindly creating another attempt. Recover committed admissions that failed before dispatch, including failures while obtaining context or minting managed MCP credentials.

Every claimed attempt reserves capacity until verified finalization or verified yield. HITL and uncertainty continue to count even if their execution Promise returns. The durable representation may reuse existing run/lock records; a separate general resource-pool framework is unnecessary. Unknown processes must not vanish from occupancy merely because their run is no longer labelled `running`.

Finalization is fenced and idempotent. Only the matching current owner can release its reservation. Old finalizers, stop receipts, canceled timers, or delayed events cannot release a successor's lock. CPU/event-loop concurrency is not a substitute for this database boundary.

### Attempt lifecycle and safe recovery

| Event | Public result / ownership |
|---|---|
| Eligible task admitted | `todo` becomes `processing`; slot/path reserved before provider launch. |
| Human input needed | `hitl`; same reservation and deadline. |
| Matched human reply | Continue the same reserved attempt safely; no deadline reset or duplicate process. |
| Verified success | `done`; release slot/path exactly once. |
| Verified failure or timeout | `error`; release; await explicit retry. Timeout reason remains visible in conversation/diagnostics. |
| Verified user/shutdown cancellation | `cancelled`; release; no implicit requeue. |
| Verified parent yield | Follow earlier handoff specification; parent waits and capacity/path are released. |
| Unverified termination | Internal `uncertain`/quarantine; retain reservation and visible blocked reason. |

Timeout is a cancellation deadline, not proof the OS process died at exactly minute 60. Adapter deadline enforcement must continue if the engine exits. The backend persists the deadline; an engine restart honors the original time. Adapter/supervisor recovery must identify and inspect the old process tree; if that cannot be done safely, retain quarantine rather than launch replacement work. A generation change fences state mutations but cannot stop a process from writing files.

After a stop request, allow at most 5s for normal process-tree termination before escalation; bound verification attempts and preserve uncertainty if they fail. A race between completion, timeout, yield, and cancel has one authoritative finalization; no second release or contradictory terminal chat message. Parent yield does not become ordinary task success merely because the stopped provider emitted a terminal event.

Startup failure to read/reconcile durable ownership disables new admission until reconciliation succeeds. Existing unknown runs count toward capacity. Recovery may resume monitoring an existing process with authenticated ownership handling; it must not impersonate an old owner or start another harness to reconstruct missing events.

Use existing process-stop verification, enriched only where evidence is insufficient. Do not treat a sent signal, resolved/rejected Promise, provider `completed` event, parent PID exit, or client-supplied boolean as proof the entire writer process tree is gone. Administrative recovery requires verified absence; any exceptional operator override must explicitly disclose that the no-overlap guarantee is no longer proven.

### Acceptance matrix for implementation

Use contract, integration, and process checks with disposable repos/data. No unit tests, screenshots, or parallel coding agents in the shared checkout. These checks are requirements, not results already obtained.

| ID | Scenario | Pass criterion |
|---|---|---|
| P1 | Queue tasks through MCP and launch actual services | Engine dispatches automatically; one new admission per tick; no overlapping cycles or queued catch-up work. |
| P2 | Queue at least nine independent long-running tasks | Eight harness processes can overlap; ninth waits. Full pool issues no new task queries/claims; control operations remain responsive. |
| P3 | Many tasks share one absolute path, including symlink/case aliases | Measured writer intervals never overlap. Separate canonical local folders may overlap even with the same Git remote. |
| P4 | Several engine processes/backend connections contend | One owner per task/path; total reservations never exceed eight. Exercise existing direct claim routes too. |
| P5 | Busy high-priority repo; eligible tasks elsewhere | Other repos progress. P0–P3, enqueue-time FIFO, deterministic tie-breaking, and non-preemption hold. |
| P6 | Concurrent streams, cancellation, and HITL | No cross-run messages/sequence/state contamination; polling continues while resumes or stops are pending. HITL retains capacity/deadline. |
| P7 | Crash between claim, start, event commit, and finalization; lost ACK | No duplicate task or harness. Durable receipts/reconciliation recover or quarantine; no slot/lock is silently dropped. |
| P8 | Deadline expiry and restart | Persisted 60-minute deadline is enforced without reset, including HITL. Verify using a controlled clock or test-only shorter deadline, without changing the production default. |
| P9 | Timeout while a child process survives or adapter is unreachable | No same-path replacement starts; reservation remains until verified stop. Timer expiry alone never releases it. |
| P10 | Completion/cancel/timeout/yield races and stale generation | One fenced finalization; no successor lock release; expected task status/reason preserved. |
| P11 | Graceful shutdown during work and during claim | No new admissions after shutdown begins; in-flight admission is resolved safely. Drain/stop policy is bounded; unresolved runs remain durable. |
| P12 | Backend outage, slow claim, and large backlog | Bounded promises/queries/retries; no overlapping polls, busy spin, or full-backlog transfer. Event loop and active-run controls remain responsive. |
| P13 | Upgrade with limits 3, 8, and 10 plus legacy active runs | Settings preserved; effective cap respected; deadlines/backfill and uncertain ownership are safe. |
| P14 | Installed Codex and Claude | Actual startup-to-completion/cancel smoke evidence for each, reported separately from fake-process checks. No new Agy driver is required. |

Measure actual process write/start/stop intervals and backend reservations, not just mocked status labels. Run typecheck, lint, build, and affected existing integration suites. Report baseline vs changed query counts, dispatch latency, peak occupancy, polling overlap, and active-run control latency under eight concurrent tasks. Record unverified provider/OS cases explicitly.

### Bottlenecks and trade-offs

- **Dispatch pacing:** One admission per 100ms gives an ideal ceiling of ten new attempts/second. Eight initial tasks need seven tick intervals after the first admission to fill capacity. Timers/IPC can add latency; exact 100ms timing is not guaranteed.
- **Priority starvation:** Strict priority can starve lower-priority tasks. Aging/fair-share scheduling would change policy and is out of scope.
- **SQLite:** Writes serialize in the backend. Keep transactions/indexed eligibility queries short; do not fetch and sort the full backlog in the engine. Verify query plans and backlog behavior before adding infrastructure.
- **Provider limits:** Eight slots is an upper bound, not guaranteed useful throughput. CPU/memory use in harnesses, provider rate limits, auth limits, and available independent repos may reduce concurrency.
- **CPU work:** Bound JSON/event buffers and log writes; inspect synchronous hot paths. Introduce Worker Threads only after profiling demonstrates meaningful engine-side CPU work, through a separate decision.
- **Uncertain ownership:** Safety can hold capacity/path reservations until process inspection or operator action. Automatic expiry cannot guarantee both prompt recovery and no overlapping filesystem writers.

### Integration and rollout

The earlier [handoff/single-writer repair](2026-10-24-handoff-single-writer.md) remains a prerequisite for safe yield, external repo selection, and truthful readiness. This specification adds pool admission, capacity, cadence, and deadlines; it does not replace those protections. Review Claude's completed changes before selecting implementation details.

Use additive migrations. Existing unresolved attempts count toward capacity immediately; assign legacy deadlines from their persisted claim/start time plus 60 minutes. Already overdue attempts enter safe timeout recovery, never automatic release. Do not edit already-applied migration contents. Old engines can bypass new admission guarantees, so stop old engine processes during upgrade and refuse incompatible internal protocol/schema versions before admitting work.

Inspected baseline on 2026-10-24, while the handoff repair was in progress:

- [Runtime](../src/execution-engine/runtime.ts): default 250ms loop; settings/status work shares its critical path; HITL continuation awaited inside polling.
- [Scheduler](../src/execution-engine/scheduler.ts): default concurrency three; full runnable-list fetch; enqueue-time FIFO; local occupancy caches.
- [Run repository](../src/backend/domains/task/runs.ts): existing locks/fencing; claim authorization reads precede its write transaction; claim receipts use process-local memory.
- [Dispatcher](../src/execution-engine/dispatcher.ts): instance-owned delta/sequence state needs concurrent-run isolation verified before increasing concurrency.
- [Settings](../src/contracts/settings.ts): public range 1–10; stored default three in the existing migration.
- [Canonical path](../src/backend/canonical-path.ts): existing local identity normalization. [Adapter drivers](../src/agent-adapter/drivers/index.ts): subprocess ownership belongs to the adapter.

These are source observations, not benchmark or concurrency-test results. Re-read the changed call chains after the prior repair lands; do not overwrite its in-progress implementation.

### Runtime references

- [Node.js Worker Threads](https://nodejs.org/api/worker_threads.html): workers target CPU-intensive JavaScript; built-in async I/O is appropriate for I/O-heavy orchestration.
- [Bun SQLite transactions](https://bun.sh/docs/runtime/sqlite#transactions): synchronous transaction APIs include immediate transactions; no network/process wait belongs inside one.
- [Node.js timers](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args): timer callbacks do not have exact real-time scheduling guarantees.
