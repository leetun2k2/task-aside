# Layer refactor: task cards

## TL;DR

- **Goal:** Give Antigravity one bounded outcome and pass condition per task.
- **Key decision:** Follow the [tracker](01-execution-plan.md) for dependencies, status, and evidence.
- **Impact:** 47 slices across the confirmed [whole-repository plan](../2026-10-25-layered-code-organization.md).

**2026-10-28 update:** The [continuation audit](../2026-10-28-layered-refactor-continuation/00-overview.md), [lifecycle cards](../2026-10-28-layered-refactor-continuation/01-lifecycle-cards.md), and [remaining owner cards](../2026-10-28-layered-refactor-continuation/02-owner-cards.md) supplement unfinished cards with exact files, current Intake/multi-repo contracts, safety prerequisites, and verification. Existing numbering is unchanged: LC-06 access, LC-07 frontend, LC-08 engine, LC-09 adapter. Darwin arm64 is the sole release target; LC-12d/e are dropped, not passed. Completed-card evidence is unchanged.

## Scope

### In scope

**Ready:** Retained LC-01a–LC-12f cards, subject to tracker status and continuation prerequisites. LC-12d/e are dropped. Cards inherit all tracker rules. Required provider/Darwin gates need actual environment access; unavailable access is a named blocker, not a fabricated pass.

### Out of scope

New product/runtime protocols, schema migrations, toolchain upgrades, unit-test authoring, screenshots, generic factories/repositories, external publishing, and commits/pushes.

## Task details

`Checks` lists existing package script names or the additional integration evidence needed. Run them with the isolation classified in LC-01a. Do not rely solely on source-string checks for UI or process behavior. Scope identifies current responsibility boundaries, not a fixed list of new filenames.

### LC-01a

**Inventory commands and safe environments**

- **Deliver:** Read scripts, CI, launcher, provider checks, and cleanup paths. Classify each command as in-process, fake-process, live-provider, browser, or native-OS. Record runtime/tool versions and isolated invocations.
- **Scope:** All owners, package scripts, CI; documentation only.
- **Accept:** Every planned command has a safe disposable setup or a concrete access blocker; no real install or registered work repo is used.
- **Checks:** Inspect scripts; no application mutations.

### LC-01b

**Record backend contract baseline**

- **Deliver:** Run classified backend suites; record wire shapes, error precedence, query order/cursors, schema version, checksums, ownership, and rollback coverage gaps.
- **Scope:** Backend and contracts; evidence only.
- **Accept:** Passing and failing results are separate; baseline includes duplicate events, scope denial, stale HITL replies, fencing, and stop requirements.
- **Checks:** test:contracts, test:db, test:api, test:runs, test:events, test:mcp, test:projection

### LC-01c

**Record UI and lifecycle baseline**

- **Deliver:** Run classified browser, fake-runtime, supervisor, and install checks. Record task switching, reconnect, worker occupancy, startup, cancellation, and cleanup.
- **Scope:** Frontend, engine, adapter, supervisor, distribution; evidence only.
- **Accept:** UI is checked through interactions; process checks prove no duplicate writer and retain uncertain ownership. Missing environments remain explicit.
- **Checks:** test:ui, test:workflow, test:browser, test:harness, test:engine, test:startup, test:pool, test:adapter, test:safety, test:services, test:supervisor, test:distribution

### LC-02a

**Pilot settings layers**

- **Deliver:** Separate settings/diagnostics reads and updates into handlers, application actions, actual rules, and concrete SQL access. Keep one database connection and existing response shapes.
- **Scope:** Backend settings/API and directly affected callers.
- **Accept:** Settings read/update and invalid input behave as before; simple reads bypass empty services; diagnostics remain compatible.
- **Checks:** test:db, test:api, test:projection

### LC-02b

**Separate Git repository registration**

- **Deliver:** Extract registration/listing storage from canonical-path and duplicate-registration rules; route callers through application actions.
- **Scope:** Backend repository registry/API and directly affected callers.
- **Accept:** Paths and aliases resolve consistently; duplicate and invalid paths return current errors; provider defaults remain repository-owned.
- **Checks:** test:db, test:api

### LC-03a

**Separate task and context reads**

- **Deliver:** Extract task/list/context SQL projections and row mapping; preserve parent/child summaries and bounded message context. Remove read dependencies on the run re-export barrel where practical.
- **Scope:** Backend Task read paths and Task/Chat projection callers.
- **Accept:** Filters, stable ordering, active-run fields, cursor behavior, and context limits match baseline; no new writer or query-per-row regression is introduced.
- **Checks:** test:api, test:runs, test:projection

### LC-03b

**Extract task creation**

- **Deliver:** Coordinate Task and Chat creation in a single application transaction; extract child rules and domain writes; defer publication to the outer commit. Migrate affected callers, including external MCP creation if it wraps the action.
- **Scope:** Backend task creation, conversation creation, affected MCP caller.
- **Accept:** One task and conversation are committed together; outer receipt failure rolls back both and emits no browser event; existing defaults and errors remain.
- **Checks:** test:db, test:api, test:mcp; rollback integration case if missing

### LC-03c

**Extract task editing**

- **Deliver:** Move edit orchestration from transport/domain mixtures into the task action and rules, with SQL in its repository.
- **Scope:** Backend task update and affected REST/MCP callers.
- **Accept:** Allowed fields, status guards, version increments, and committed event payloads stay compatible; rejected edits do not write.
- **Checks:** test:api, test:projection

### LC-03d

**Unify cancel and retry entry actions**

- **Deliver:** Move queued/live cancellation branching out of HTTP handlers; keep live cancel as intent. Extract explicit error-only retry rules and storage.
- **Scope:** Backend Task actions, run cancel-intent access, callers.
- **Accept:** Queued cancellation remains immediate; live cancellation retains ownership until verified finalize; retry rejects unsupported states and quarantine.
- **Checks:** test:api, test:runs, test:pool

### LC-04a

**Separate ordinary chat reads and writes**

- **Deliver:** Extract message queries/append storage; preserve cursor encoding and sender handling. Make message publication follow the outer action commit; migrate nested MCP message callers together.
- **Scope:** Backend Chat, REST/internal message handlers, MCP post_message.
- **Accept:** Paging and message order stay compatible; terminal tasks remain terminal; processing messages do not inject an unsafe live turn; outer rollback emits nothing.
- **Checks:** test:api, test:events, test:mcp

### LC-04b

**Extract HITL reply transaction**

- **Deliver:** Coordinate reply message, pending request, run state, and task transition in one application transaction across Task and Chat repositories.
- **Scope:** Backend Chat/Task reply paths and affected handlers.
- **Accept:** A matching request resolves once; duplicate/stale request returns REQUEST_ALREADY_RESOLVED without a second message or resume; rollback leaves all state intact.
- **Checks:** test:api, test:runs, test:events; reply rollback integration case if missing

### LC-04c

**Unify input-required application action**

- **Deliver:** Extract input-required state/message rules for adapter events and managed MCP. Keep each ingress authorization and idempotency semantics while sharing the transaction-safe core.
- **Scope:** Backend event ingestion, MCP request_input, Task/Chat writes.
- **Accept:** Question, pending request, and HITL status commit together; retained lock is unchanged; nested message publication cannot escape rollback.
- **Checks:** test:events, test:mcp, test:runs

### LC-04d

**Separate event ingestion and publication**

- **Deliver:** Extract receipt and projection SQL from orchestration; retain hashing, sequence conflicts, transient deltas, and durable effects. Publish committed notifications from the application boundary.
- **Scope:** Backend event action, repositories, hub boundary, internal handlers.
- **Accept:** Identical ACK retry is a durable no-op; differing sequence payload rejects without partial writes; batch failure emits no committed-state notification.
- **Checks:** test:events, test:projection, test:contracts

### LC-05a

**Extract atomic admission and claims**

- **Deliver:** Separate eligibility/capacity/fencing rules from concrete admission SQL. Keep eligibility checks and claim/run/lock/receipt writes within the required atomic boundary.
- **Scope:** Backend Task admission/run/lock repositories and internal handlers.
- **Accept:** Same canonical tree has one writer; eight-slot cap and configured lower limit hold; priority/FIFO and retry receipt semantics match baseline.
- **Checks:** test:runs, test:pool, test:api

### LC-05b

**Extract heartbeat ownership action**

- **Deliver:** Separate heartbeat validation and fenced lease writes; preserve existing checks and atomic scope.
- **Scope:** Backend run heartbeat and internal handler.
- **Accept:** Stale owner/generation changes nothing; valid heartbeat updates the correct run/lock; expiry never releases ownership.
- **Checks:** test:runs, test:pool

### LC-05c

**Extract verified finalization**

- **Deliver:** Coordinate terminal run/task updates, retained generation, lock release, and parent follow-up at the application boundary.
- **Scope:** Backend run finalization and affected callers.
- **Accept:** Missing/mismatched stop proof retains ownership; duplicate finalize is idempotent; preserve VERIFIED_STOP_REQUIRED rather than replacing it with a validation error.
- **Checks:** test:runs, test:events, test:pool

### LC-05d

**Separate yield intent and parent readiness**

- **Deliver:** Extract managed yield intent, child wait-set rules, and parent reconciliation without treating intent as process-exit proof.
- **Scope:** Backend Task yield/parent rules and managed MCP yield caller.
- **Accept:** Identical intent is idempotent; scope mismatch rejects; parent waits only after verified stop; failed/cancelled children remain visible and blocked.
- **Checks:** test:mcp, test:runs, test:pool

### LC-05e

**Extract uncertain-run and quarantine actions**

- **Deliver:** Separate uncertain marking and authorized quarantine clearance; use explicit repositories for state changes.
- **Scope:** Backend recovery and internal/admin handlers.
- **Accept:** Network loss or expired heartbeat never grants a second writer; clearance keeps its required authorization and evidence; rejected requests are mutation-free.
- **Checks:** test:runs, test:api, test:pool

### LC-06a

**Separate credentials and pairing**

- **Deliver:** Extract access-control usecases, scope rules, and token/pairing repositories; remove route SQL for managed token creation.
- **Scope:** Backend MCP tokens/pairing and internal token route.
- **Accept:** Managed tokens retain run/task lifecycle; external pairing/revocation remain scoped; wrong token roles and stale tokens cannot reach privileged operations.
- **Checks:** test:mcp, test:api, test:services

### LC-06b

**Extract scoped task creation for agents**

- **Deliver:** Finish managed/external creation actions using shared Task/Chat writes, retaining distinct inputs, scope, provider defaults, child limits, and durable receipts.
- **Scope:** Backend MCP create_task and Task/Chat/access usecases.
- **Accept:** Managed children stay in allowed parent/repo scope; depth/count limits hold; external idempotency is principal-scoped; payload conflict and outer rollback are safe.
- **Checks:** test:mcp, test:api, test:pool

### LC-06c

**Thin remaining MCP dispatch**

- **Deliver:** Keep protocol parsing/tool routing in handlers; delegate reads and writes to scoped application actions. Remove remaining transport-owned SQL and duplicated workflow logic.
- **Scope:** Backend MCP handlers/tools and affected usecases.
- **Accept:** Seven tools retain their supported/unsupported behavior and error shapes; managed and external scope denial are checked independently.
- **Checks:** test:mcp, test:contracts, test:projection

### LC-07a

**Separate frontend transport and browser storage**

- **Deliver:** Split HTTP/response validation from token/preference persistence and DOM theme effects without adding a second cache or copying backend models.
- **Scope:** Frontend API/query/storage/theme boundaries.
- **Accept:** Abort signals propagate; malformed reads reject; token URL cleanup and storage-denied behavior match baseline; no server imports reach the browser.
- **Checks:** test:ui, test:workflow, test:browser

### LC-07b

**Extract frontend task action hooks**

- **Deliver:** Move create/edit/cancel/retry/repo mutations from App into named handlers/client actions with scoped cache updates and pending/error state.
- **Scope:** Frontend App, dialogs, task/repo actions and query integration.
- **Accept:** Rapid actions and task switches update the intended task; validation/errors remain visible; grouping and selection remain intact.
- **Checks:** test:workflow, test:browser

### LC-07c

**Extract conversation action and query hooks**

- **Deliver:** Separate task-scoped paging, sends, pending state, drafts, and reply linkage from view composition.
- **Scope:** Frontend conversation/application actions and cache integration.
- **Accept:** Selection races never mix conversations; REST/SSE completion deduplicates; cursor pages, drafts and per-task pending/error state survive navigation.
- **Checks:** test:workflow, test:browser

### LC-07d

**Extract browser SSE and live-state rules**

- **Deliver:** Separate EventSource lifecycle/parsing from message/version reconciliation and bounded delta batching; use named callbacks.
- **Scope:** Frontend SSE handlers, live-state services, query invalidation.
- **Accept:** Reconnect refetches snapshots; stale versions cannot roll back state; task/run streams stay isolated; unmount/reconnect leaves no timers or subscribers.
- **Checks:** test:workflow, test:browser

### LC-07e

**Finish frontend presentation composition**

- **Deliver:** Keep App focused on layout and wiring; separate grouping/theme/preferences by actual responsibilities and retain existing UI primitives.
- **Scope:** Frontend App/components/grouping/theme.
- **Accept:** Two panes, both grouping modes, counts, keyboard flow, themes, dialogs and Markdown remain correct at narrow/wide layouts using DOM interactions.
- **Checks:** test:ui, test:workflow, test:browser

### LC-08a

**Separate engine clients by target**

- **Deliver:** Split concrete backend and adapter HTTP/SSE access while preserving typed request/response contracts and existing call sites.
- **Scope:** Engine clients/types and direct consumers.
- **Accept:** Bearer role, timeouts, error mapping, SSE lifecycle and stable retry payloads remain compatible; no SQLite or provider spawn imports.
- **Checks:** test:engine, test:startup, test:contracts

### LC-08b

**Separate admission actions and scheduler state**

- **Deliver:** Extract admission tick/action, scheduling rules, settings sync and transient occupancy state.
- **Scope:** Engine scheduler/admission and runtime caller.
- **Accept:** At most one outstanding admission request; retry uses the same key; cap and canonical-tree accounting remain correct and backend-authoritative.
- **Checks:** test:engine, test:pool

### LC-08c

**Separate dispatch and event delivery actions**

- **Deliver:** Extract run dispatch coordination, instruction rules and event delivery responsibilities while retaining per-run state and cleanup.
- **Scope:** Engine dispatcher/forwarder/instruction builder.
- **Accept:** Claim precedes start; ACK loss retries the identical envelope; deltas stay bounded; disconnect reconciles without duplicate spawn; timers retire with their run.
- **Checks:** test:engine, test:harness, test:pool

### LC-08d

**Separate resume, cancel, timeout and reconciliation**

- **Deliver:** Extract execution actions from mixed lifecycle branches; keep backend ownership and adapter process evidence authoritative.
- **Scope:** Engine HITL/dispatcher/reconciler actions.
- **Accept:** Unsupported resume remains explicit; deadlines do not reset; cancel/timeout releases only after verified stop; uncertainty quarantines rather than restarting.
- **Checks:** test:engine, test:startup, test:pool

### LC-08e

**Thin runtime and engine entrypoint**

- **Deliver:** Keep startup/timer/signal handlers responsible for lifecycle wiring; delegate application work to named actions.
- **Scope:** Engine runtime, handlers, cmd/execution-engine.ts.
- **Accept:** Startup reconciles persisted runs before admission; errors stay visible; bounded shutdown drains and retains uncertain work safely.
- **Checks:** test:startup, test:engine, test:pool, test:services

### LC-09a

**Separate adapter run registry and log I/O**

- **Deliver:** Extract concrete ephemeral run storage and redacted/rotated log writes from manager coordination; retain stream ownership and sequence state.
- **Scope:** Adapter manager/state/logging and consumers.
- **Accept:** Registry remains in-memory and non-authoritative for task state; log limits/redaction hold; no leaked sessions/subscribers or SQLite access.
- **Checks:** test:adapter, test:safety

### LC-09b

**Extract adapter start and inspect actions**

- **Deliver:** Separate REST handlers, start/idempotency rules and run status reads; keep provider selection explicit.
- **Scope:** Adapter start/inspect handlers, usecases/services and drivers.
- **Accept:** Repeated matching start spawns once; owner/generation mismatch rejects; cwd/capability restrictions and error shapes stay compatible.
- **Checks:** test:adapter, test:safety, test:harness

### LC-09c

**Extract adapter input and stop actions**

- **Deliver:** Separate input/cancel/deadline application coordination from low-level driver/process control.
- **Scope:** Adapter input/cancel/deadline and direct callers.
- **Accept:** Stale replies and fencing reject; cancel result represents observed stop proof; retained sessions and unsupported operations remain explicit; no invented success.
- **Checks:** test:adapter, test:safety, test:pool

### LC-09d

**Separate adapter streams and callbacks**

- **Deliver:** Extract REST/SSE queue lifecycle and named typed driver callbacks. Keep protocol parsing in drivers and preserve the deterministic fake-scenario injection path.
- **Scope:** Adapter HTTP/SSE handlers, run stream and driver callbacks; check support as needed.
- **Accept:** Buffer/replay/sequence order remain compatible; slow/disconnected clients clean up; fake checks never invoke real providers; driver semantics remain unchanged.
- **Checks:** test:adapter, test:safety, test:harness, test:engine

### LC-10a

**Separate CLI parsing and rendering**

- **Deliver:** Move command validation and output formatting out of start/status/stop application actions; leave cmd/cli.ts as wiring.
- **Scope:** CLI entrypoint and supervisor presentation/handlers.
- **Accept:** Help/version/default command/invalid-command output and exit codes remain compatible; browser launch still follows the chosen command behavior.
- **Checks:** test:distribution, test:release-candidate, test:services

### LC-10b

**Separate supervisor storage and process I/O**

- **Deliver:** Extract concrete lock/token file access and process/browser/health calls from lifecycle policy. Preserve runtime dependencies until shared-helper consolidation.
- **Scope:** Supervisor process manager, auth, paths, process/browser/health modules.
- **Accept:** Disposable paths, file modes, process identity and single-instance guards remain compatible; partial failures clean up only resources created by this run.
- **Checks:** test:supervisor, test:services, test:distribution

### LC-10c

**Extract supervisor lifecycle actions**

- **Deliver:** Keep start/status/stop usecases and readiness/shutdown policy separate from CLI and concrete I/O.
- **Scope:** Supervisor lifecycle and command consumers.
- **Accept:** Backend→adapter→engine readiness order holds; restart and failed-start behavior stay safe; stop does not infer group death from a sent signal.
- **Checks:** test:supervisor, test:services, test:startup, test:distribution

### LC-11a

**Consolidate concrete shared infrastructure**

- **Deliver:** Move already-shared HTTP/auth/Host/Origin and server path helpers out of supervisor ownership with all consumers; retain credential provisioning ownership and explicit dependency direction.
- **Scope:** Shared server infrastructure, supervisor, all service compositions.
- **Accept:** Shared modules import no application owner; browser imports none; token roles, Host/Origin checks, health shape and data-dir resolution remain compatible.
- **Checks:** test:services, test:api, test:mcp, test:contracts, test:supervisor

### LC-11b

**Finish Node launcher and installed payload**

- **Deliver:** Separate concrete Node installation/runtime concerns only where useful; update launcher declarations and packaged file lists with any move.
- **Scope:** bin/, packaging/build scripts and distribution consumers.
- **Accept:** Node help/version work before Bun app startup; stable payload works without source/npx cache paths; imports stay Node-compatible; no new package is published.
- **Checks:** test:distribution, test:release-candidate; inspect package contents and run isolated installed-payload smoke

### LC-11c

**Align check support and build wiring**

- **Deliver:** Update harness/benchmarks/check imports and CI/package entrypoints for final layout. Keep fake scenarios available through explicit existing injection and out of provider production behavior.
- **Scope:** Check support, benchmarks, package scripts, CI; no toolchain upgrade.
- **Accept:** All existing commands still resolve; checks are not weakened; fake checks stay isolated; bundles exclude check-only support and retain required runtime modules.
- **Checks:** test:harness, test:contracts, test:distribution; build and package-content inspection

### LC-12a

**Remove bridges and enforce layer boundaries**

- **Deliver:** Remove temporary forwarding exports/duplicate old logic after all callers move. Extend architecture checks to resolved paths, aliases and re-exports with explicit runtime/check distinctions.
- **Scope:** All owner imports, contracts architecture checks, architecture and AGENTS documentation.
- **Accept:** No reverse layer dependency or cross-owner private runtime import remains; SQL is limited to backend repositories/DB setup; negative boundary fixtures reject violations.
- **Checks:** test:contracts; typecheck, lint, build

### LC-12b

**Run final local regression**

- **Deliver:** Run aggregate checks and browser/installed-payload verification in fresh disposable environments; compare relevant baseline behavior and resource cleanup.
- **Scope:** Whole repository; verification and narrowly scoped regression repairs.
- **Accept:** Record exact current commands/results; no claim of whole-repo completion from compilation or source-string assertions; regressions are fixed and affected checks rerun.
- **Checks:** check, test:browser, test:release-candidate; isolated start/status/stop and package smoke

### LC-12c

**Verify current Codex and Claude paths**

- **Deliver:** Run classified live checks in disposable repos when executable/auth/access exist; report each provider separately, especially after driver/callback/process changes.
- **Scope:** Existing provider integrations; evidence only unless a scoped regression fix is required.
- **Accept:** Current start/stream/complete/cancel results and stop proof are recorded; resume/MCP limitations remain honest. Missing provider access blocks only that gate.
- **Checks:** test:codex, test:claude; actual installed CLI evidence

### LC-12d

**Dropped: native Linux gate**

- Current user scope is Darwin arm64 only (2026-10-28). Keep this ID for history; no execution dependency or pass claim.

### LC-12e

**Dropped: native Windows gate**

- Current user scope is Darwin arm64 only (2026-10-28). Keep this ID for history; no execution dependency or pass claim.

### LC-12f

**Publish local handoff completion report**

- **Deliver:** Reconcile tracker and per-task evidence; summarize final layout, contract compatibility, commands, baseline regressions, provider/OS gates and rollback. Update main plan's implementation status truthfully.
- **Scope:** Planning/evidence documents and contributor/architecture links.
- **Accept:** Report can be written with blocked environment gates, but overall status stays partial until every required gate passes. No commit, push or external publication.
- **Checks:** Validate tracker/card/evidence links and every completion claim against recorded results.
