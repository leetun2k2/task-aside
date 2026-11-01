# Remaining owner cards: LC-06 through LC-12

## TL;DR

- **Goal:** Finish one owner at a time after the lifecycle slices.
- **Key decision:** Carry full run scope and purpose through every layer; retain existing card numbers.
- **Impact:** Access, frontend, engine, adapter, CLI, shared infrastructure, and Darwin acceptance.

## Scope

**In scope — Ready:** Existing unfinished owner extractions with the adjustments below. **Out of scope:** new UI/features/providers, unit tests, screenshots, generic factories, package publication, and non-Darwin release gates. Provider release claims remain gated by live proof as stated in the [overview](00-overview.md).

Paths are exact repository-relative targets; brace lists enumerate separate files. **Create** means proposed, not present. Only create a module when moving real logic into it. Each card inherits `bun run typecheck`, `bun run lint`, and the owner build: frontend `bun run build:ui`, services `bun run build:services`, packaging `bun run build`. Every listed check is run as `bun run <script>`.

All runtime contracts remain in `src/contracts/`. No database imports outside `src/backend/`; current check-only exceptions are removed in LC-11c by moving DB-owning integration setup. Engine clients remain HTTP; provider drivers remain explicit subprocess I/O; Query remains the sole frontend server cache. Do not add a repository/service for a forwarding call.

## LC-06 remains MCP/access

### LC-06a — Credentials and pairing

- **Touch:** `src/backend/mcp/{tokens,handler}.ts`, `src/backend/api/{runs,index}.ts`, `src/backend/{mcp-checks,api-checks}.ts`.
- **Create:** `src/backend/domains/access/repositories/mcp-token-repository.ts`, `src/backend/domains/access/services/mcp-scope-service.ts`; access usecases `mint-managed-token-usecase.ts`, `validate-token-usecase.ts`, `create-pairing-usecase.ts`, `approve-pairing-usecase.ts`, `revoke-token-usecase.ts`, `list-tokens-usecase.ts`.
- **Input → output:** Existing run/token/pairing requests → unchanged credential/auth context/error shapes. Internal route resolves the run's task through a repository, not SQL in the handler. Token validation coordinates Task/access at the usecase boundary; Task services never import access services.
- **Adjustment:** Derive allowed tool profile from persisted run purpose; an Intake caller cannot choose `full`. Both `mcp/handler.ts` and `api/runs.ts` register the managed-token path; converge on one action/route so mount order cannot drop the profile. Preserve current scoped MCP delegation; no accidental `request_input`/`yield_task` grant during Intake. Validate active task/run binding and ownership; ended/uncertain runs cannot use credentials. Distinguish lazy expiry from physical revocation.
- **Verify:** `test:mcp`, `test:api`, `test:services`, `test:runs`. Check both roles independently, profile escalation, mismatched task/run, ended token, pairing expiry, and revoked token.

### LC-06b — Agent task creation

- **Touch:** `src/backend/mcp/tools.ts`, `src/backend/domains/task/usecases/create-task-usecase.ts`, task-write/message/conversation repositories and `src/backend/mcp-checks.ts`.
- **Create:** `src/backend/usecases/create-managed-task-usecase.ts`, `src/backend/usecases/create-external-task-usecase.ts`, `src/backend/domains/access/repositories/create-receipt-repository.ts`.
- **Input → output:** Auth context + existing message-first MCP create params → existing Task response. Each usecase coordinates access, Task, and Chat with one immediate transaction for child budget/identity and writes.
- **Adjustment:** No required resolved repo or inherited primary repo. Bound child authorization to the caller's allowed catalog; enforce parent=current task, depth 0 only, five-child cap, origin run/key, principal-scoped external receipts, and shared-conversation permission. Retry identity is checked before consuming another child slot. Intake children stay staged until accepted `delegate`; implementation/legacy creation retains its current semantics.
- **Verify:** `test:mcp`, `test:api`, `test:pool`, `test:events`. Cover changed-payload retry, duplicate at child limit, staged activation, catalog denial, receipt rollback, and zero pre-commit publication.

### LC-06c — Thin tool dispatch

- **Touch:** `src/backend/mcp/{tools,handler,schema}.ts`, `src/backend/usecases/{request-input-usecase,reply-hitl-usecase}.ts`, task/chat usecase callers, `src/backend/{mcp-checks,projection-checks}.ts`.
- **Create:** `src/backend/usecases/get-scoped-task-usecase.ts`, `list-scoped-tasks-usecase.ts`, `get-scoped-messages-usecase.ts`, `post-scoped-message-usecase.ts`.
- **Input → output:** Validated tool + auth context → current tool response/error. Handler retains protocol parsing and dispatch; scoped actions own resource checks and delegate writes to the existing actions. Yield uses LC-05d directly.
- **Adjustment:** Preserve seven tools and current unsupported external operations. Shared conversations require exact task targeting and retain `originTaskId`; Intake question creation comes from accepted routing JSON, not MCP `request_input`. Complete-scope ownership checks use durable state.
- **Verify:** `test:mcp`, `test:contracts`, `test:projection`, `test:events`.

## LC-07 targets WorkspacePage and AppShell

`App.tsx` is already thin. The mixed view/query/mutation/SSE code is now in `pages/WorkspacePage.tsx`; repository actions are in `components/AppShell.tsx`. The old App-only scope would miss both.

### LC-07a — Client and browser storage

- **Touch:** `src/frontend/{api,queries,theme,grouping}.ts` and their callers.
- **Create:** `src/frontend/data/http-client.ts`, `task-client.ts`, `chat-client.ts`, `repository-client.ts`, `settings-client.ts`, `auth-storage.ts`, `preference-storage.ts`. Retain `api.ts` as a temporary bridge.
- **Input → output:** Existing typed endpoint calls + signal/token options → validated contract DTOs/errors; browser preferences/token URL → current stored values and DOM theme effects. Keep query keys/cache ownership in `queries.ts`.
- **Adjustment:** Preserve nullable repo, stage, all resolved IDs, message-only create, and `targetTaskId`; never collapse them into the former required-repo model. Keep token URL cleanup and storage-denied handling. No server-only imports.
- **Verify:** `test:ui`, `test:workflow`, `test:browser` using DOM/CDP interactions without image capture.

### LC-07b — Task and repository actions

- **Touch:** `src/frontend/pages/WorkspacePage.tsx`, `src/frontend/components/{AppShell,CreateTaskModal,EditTaskModal}.tsx`, `src/frontend/pages/settings/RepositoriesTab.tsx`.
- **Create:** `src/frontend/handlers/use-task-actions.ts`, `use-repository-actions.ts`.
- **Input → output:** Captured target task/repo ID + validated form data → client mutation, scoped Query update/invalidation, pending/error state. No extra usecase layer for a simple HTTP forwarding action.
- **Adjustment:** Message remains the required create field; optional hints/overrides stay optional. Preserve edit-message admission guard, Intake retry/cancel, and asynchronous title/repo resolution. A late response cannot mutate a newly selected task.
- **Verify:** `test:workflow`, `test:browser`, `test:ui`.

### LC-07c — Conversation hooks

- **Touch:** `src/frontend/pages/WorkspacePage.tsx`, `src/frontend/components/TaskConversation.tsx`, `src/frontend/queries.ts`.
- **Create:** `src/frontend/handlers/use-task-conversation.ts`, `src/frontend/services/message-projection-service.ts`.
- **Input → output:** Task ID + draft/send/reply/cursor actions → paged messages, task-scoped pending/errors/draft and deduplicated cache writes. Use named callbacks; pass cancellation signals.
- **Adjustment:** Shared parent/verification conversation keeps task attribution and exact reply target. Intake replies queue a fresh attempt; implementation replies resume retained ownership. Do not infer either server transition as authoritative from a send success alone; invalidate/refetch the task after replying. Cover navigation away and back, not just switching between already-mounted tasks.
- **Verify:** `test:workflow`, `test:browser`, `test:projection`.

### LC-07d — Browser events and live rules

- **Touch:** `src/frontend/pages/WorkspacePage.tsx`, `src/frontend/queries.ts`, `src/contracts/browser-events.ts` only if a prerequisite added a coordinated field.
- **Create:** `src/frontend/data/browser-event-stream.ts`, `src/frontend/handlers/use-workspace-events.ts`, `src/frontend/services/live-state-service.ts`.
- **Input → output:** Valid browser envelopes → bounded transient deltas and version-safe Query projection/invalidation. Named event callbacks own connect, reconnect, abort, and timer cleanup.
- **Adjustment:** `intake → ready` changes repo/title/priority/provider beyond the existing status event; refetch when the projection is incomplete. Raw routing JSON must not become chat. Old Intake/run deltas cannot bleed into an implementation attempt; shared conversations deduplicate durable IDs while preserving task origin.
- **Verify:** `test:workflow`, `test:browser`, `test:ui`; stale versions, reconnect snapshots, route unmount/remount, and concurrent streams.

### LC-07e — Presentation composition

- **Touch:** `src/frontend/{App,router}.tsx`, `src/frontend/components/AppShell.tsx`, `src/frontend/pages/{WorkspacePage,DashboardPage}.tsx`, `src/frontend/{theme,grouping}.ts`.
- **Create:** `src/frontend/handlers/use-workspace-preferences.ts` for existing grouping/theme/preferences lifecycle; move actual rules without empty service wrappers.
- **Input → output:** Hook view models + named actions → existing routes, task groups, conversation and settings presentation. Keep one Query provider/cache and existing selection wiring.
- **Adjustment:** Preserve Intake badges, unresolved repo rendering, full resolution updates, and parent/verification links. Record settings-route versus modal scope conflict from LC-00p; resolve as a separate explicit UI decision, with no silent page addition/removal here.
- **Verify:** `test:ui`, `test:workflow`, `test:browser`; keyboard, narrow/wide DOM layouts, grouping, Markdown, themes, and settings.

## LC-08 preserves the full claim

### LC-08a — Clients by target

- **Touch:** `src/execution-engine/{client,types,index}.ts` and scheduler/dispatcher/reconciler/HITL/runtime imports.
- **Create:** `src/execution-engine/clients/backend-client.ts`, `adapter-client.ts`.
- **Input → output:** Existing typed commands → current HTTP/SSE responses, role headers, timeout/error mapping. Keep errors with their target; a temporary facade may re-export them.
- **Adjustment:** Carry `purpose`, full admitted projection, `runFence`, per-tree map, input revision, original deadline, and Intake outcome endpoints. Do not default absent ownership/scope fields for implementation. Shared context comes from contracts, not backend imports.
- **Verify:** `test:engine`, `test:startup`, `test:contracts`, `test:harness`.

### LC-08b — Admission and occupancy

- **Touch:** `src/execution-engine/{scheduler,runtime,types}.ts`.
- **Create:** `src/execution-engine/usecases/admit-task-usecase.ts`, `src/execution-engine/state/active-run-registry.ts`; retain real ordering/cap rules in `scheduler.ts` until callers move.
- **Input → output:** One admission tick + stable request key → full admitted claim or existing skip reason. Store the immutable claim with each active run, not only its primary tree key.
- **Adjustment:** Preserve single outstanding request and identical retry key. Intake occupies one slot without a repo key; a synthetic scratch key stays local bookkeeping. A multi-root run occupies one slot and all real roots. Backend capacity includes `uncertain`; dropping a monitor never frees durable occupancy. Preserve enough local unresolved state for recovery/shutdown, even if streaming state is retired.
- **Verify:** `test:engine`, `test:pool`, `test:startup`; lost bulk ACK, two engines, busy secondary, and uncertain occupancy.

### LC-08c — Dispatch, instructions, and events

- **Touch:** `src/execution-engine/{dispatcher,event-forwarder,instruction-builder,routing-instruction,runtime,types}.ts`.
- **Create:** `src/execution-engine/usecases/dispatch-task-usecase.ts`, `dispatch-intake-usecase.ts`; retain instruction and event delivery modules as concrete services rather than duplicating them.
- **Input → output:** Full admitted claim + matching run-bound context → exact adapter start, sequenced event delivery, and current DispatchResult. Backend snapshot controls scope; prompt uses that same list.
- **Adjustment:** Repair the current runtime's `{runId,generation}` narrowing before moving it. No primary-only fallback for a multi-root run. Intake uses scratch cwd, empty write roots, bounded original deadline, routing version and current restricted profile. Keep run-scoped timers/cursors and identical durable retry envelopes. A start transport failure is unknown until inspect/reconciliation; never creates a second launch identity.
- **Verify:** `test:engine`, `test:harness`, `test:pool`, `test:events`. Exercise the real runtime admission-to-dispatch path with two roots and unequal generations; do not manually inject roots as the only proof.

### LC-08d — Resume, cancel, timeout, reconciliation

- **Touch:** `src/execution-engine/{hitl,dispatcher,reconciler,runtime,types}.ts`.
- **Create:** `src/execution-engine/usecases/resume-hitl-usecase.ts`, `cancel-run-usecase.ts`, `timeout-run-usecase.ts`, `reconcile-run-usecase.ts`.
- **Input → output:** Backend run/admitted projection + adapter observation → continued same scope, verified finalization, or whole-scope uncertainty. Never rebuild permission from mutable task context after restart.
- **Adjustment:** Both session-resume and fresh-turn branches reapply roots, generations, run fence, deadline, and launch identity. Intake restart consumes a typed outcome through commit/fail, never generic `done`; task-level Intake reply starts a new attempt. Fetch persisted owner for reconciliation without granting a new writer. Stop method cannot be guessed from terminal status; preserve quarantine if backend ACK is unknown.
- **Verify:** `test:engine`, `test:startup`, `test:pool`, `test:runs`; multi-root HITL, old-turn proof, changed registry, lost ACK, backend/adapter restart, and timeout.

### LC-08e — Runtime handlers

- **Touch:** `src/execution-engine/runtime.ts`, `src/cmd/execution-engine.ts`.
- **Create:** `src/execution-engine/handlers/admission-tick.ts`, `control-tick.ts`, `shutdown-handler.ts`.
- **Input → output:** Startup/timer/signal → named execution actions and bounded cleanup. Runtime remains composition and loop lifetime; no SQL or spawn.
- **Adjustment:** Startup must load/reconcile unresolved attempts before admission, including Intake and uncertain runs, retaining every root. Shutdown drains, terminates, then commits proof or uncertainty; retain enough registry state to terminate unresolved processes. Deadlines never refresh on restart.
- **Verify:** `test:startup`, `test:engine`, `test:pool`, `test:services`.

## LC-09 extracts adapter policy without inventing driver guarantees

### LC-09a — Registry and logs

- **Touch:** `src/agent-adapter/{manager,types,logging,event-stream}.ts`.
- **Create:** `src/agent-adapter/state/run-registry.ts`; retain `logging.ts` and `event-stream.ts` as the already-explicit I/O/state modules. Reuse the launch journal from LC-05c-p.
- **Input → output:** Run/launch identity → ephemeral AdapterRun/session/sequence access; log entries → bounded redacted files. No second copy of durable backend task status.
- **Adjustment:** Retain immutable root/fence/deadline data and verified receipt separately from transient SSE buffers. Journal contains only necessary process identity, never MCP secrets. Keep slow-consumer/unsubscribe behavior and bounded registry cleanup.
- **Verify:** `test:adapter`, `test:safety`; ensure fake runs use a temporary data directory, not the existing `undefined/logs` path.

### LC-09b — Start and inspect

- **Touch:** `src/agent-adapter/{service,manager,capabilities,types}.ts`, `src/agent-adapter/drivers/{index,types}.ts`.
- **Create:** `src/agent-adapter/handlers/run-handlers.ts`, `src/agent-adapter/usecases/start-run-usecase.ts`, `inspect-run-usecase.ts`, `src/agent-adapter/services/run-start-service.ts`.
- **Input → output:** Validated v2 start → one driver launch or exact existing result; status/outcome queries retain shapes. Provider choice stays an explicit switch/branch or existing concrete driver map, not a factory.
- **Adjustment:** Check complete root/fence keys, canonical cwd membership, supported profile, payload identity and current capability before spawn. Preserve empty Intake scope. Current capability is binary-presence based and manager gates by name; neither is live permission proof. Keep agy blocked for Intake/multi-root. Do not relaunch after an ambiguous journal entry.
- **Verify:** `test:adapter`, `test:safety`, `test:harness`, `test:contracts`; changed roots/instruction/deadline under same identity must conflict rather than be silently accepted.

### LC-09c — Input and stop

- **Touch:** `src/agent-adapter/{manager,service}.ts`, `src/agent-adapter/drivers/{types,process-group,codex,claude}.ts`; audit agy stop callers without enabling new capability.
- **Create:** `src/agent-adapter/usecases/provide-input-usecase.ts`, `stop-run-usecase.ts`, `enforce-deadline-usecase.ts`. Reuse `services/run-stop-service.ts` from LC-05c-p.
- **Input → output:** Scoped input/cancel/deadline → existing response plus only independently verified current-launch evidence. Driver cancel returns observation; action decides state/notification.
- **Adjustment:** Preserve declared Codex/Claude mid-process-input limits. Await timeout cancel. False stop remains false in status/outcome as well as response. Reuse completed proof repairs; extract them without weakening their tests. Never stamp proof from a missing process map entry or terminal enum.
- **Verify:** `test:adapter`, `test:safety`, `test:pool`, `test:engine`; changed driver/process behavior also requires LC-12c live proof.

### LC-09d — Streams and named callbacks

- **Touch:** `src/agent-adapter/{service,manager,event-stream}.ts`, `src/agent-adapter/drivers/{types,codex,claude}.ts`.
- **Create:** `src/agent-adapter/handlers/run-events-handler.ts`, `driver-event-handlers.ts`; move existing deterministic scenarios to `src/harness/adapter-scenarios.ts` with explicit check-only injection.
- **Input → output:** Typed driver callbacks → ordered normalized events/outcome; subscriber cursor → bounded SSE replay and clean close. Parsing stays provider-specific.
- **Adjustment:** Intake outcome is typed JSON metadata; never infer process proof from `completed`. Stream close and launch stop remain separate. Keep current scoped MCP/stdin/argv mapping when moving code; any permission-profile repair from MR-05 is a separate named safety change with denial evidence. No generic success fallback when a real driver is absent.
- **Verify:** `test:adapter`, `test:safety`, `test:harness`, `test:engine`; fake paths must not invoke installed providers.

## LC-10 keeps CLI and supervisor responsibilities clear

### LC-10a — CLI parsing and rendering

- **Touch:** `src/cmd/cli.ts`, `src/supervisor/browser.ts`.
- **Create:** `src/supervisor/handlers/cli-handler.ts`, `src/supervisor/presentation/cli-output.ts`.
- **Input → output:** Existing argv → validated start/status/stop action and unchanged help/version/exit semantics. Preserve the distinct direct Bun CLI and Node-launcher default behavior.
- **Adjustment:** Render safe user URLs without logging credentials. Record current CLI token-bearing URL output as an explicit redaction repair; browser bootstrap still receives its token. Expose unresolved work accurately without adding new product commands.
- **Verify:** `test:distribution`, `test:release-candidate`, `test:services`; no real browser launch or live installation.

### LC-10b — Supervisor storage and process I/O

- **Touch:** `src/supervisor/{process-manager,auth,paths,browser,health-check,ports}.ts`.
- **Create:** `src/supervisor/storage/instance-lock.ts`, `credential-files.ts`, `src/supervisor/process/service-process.ts`.
- **Input → output:** Instance identity/config → concrete file/readiness/spawn/stop observations. File paths/modes stay stable; credential provisioning stays supervisor-owned.
- **Adjustment:** Darwin process groups/fingerprints and whole-service uncertainty replace no proof with a signal-only success. Do not conflate stopping service groups with verifying detached provider groups. Retain app-owned Intake scratch paths and `TASKASIDE_DATA_DIR` isolation. Remove only resources created by the failed start.
- **Verify:** `test:supervisor`, `test:services`, `test:distribution` on Darwin arm64.

### LC-10c — Lifecycle actions

- **Touch:** `src/supervisor/process-manager.ts`, `src/cmd/cli.ts` and new process/storage modules.
- **Create:** `src/supervisor/usecases/start-services-usecase.ts`, `status-services-usecase.ts`, `stop-services-usecase.ts`, `src/supervisor/services/lifecycle-service.ts`.
- **Input → output:** CLI lifecycle command → observed handles/status or bounded safe stop. Backend → adapter → engine readiness; reverse stop with engine drain first. No task retry by supervisor.
- **Adjustment:** Current manager relies on detached children and a lock; the lock's `pid` alone is not evidence of a persistent supervisor. Prove lifetime/health behavior or record a separate scoped repair. Failed readiness must clean earlier children created by this start; stopping cannot delete the instance record while known writers remain unresolved. Preserve durable backend locks on forced service failure.
- **Verify:** `test:supervisor`, `test:services`, `test:startup`, `test:distribution`, plus installed detach/status/stop and lingering-child process assertions.

## LC-11 consolidates shared I/O and check support

### LC-11a — Shared concrete infrastructure

- **Touch:** `src/supervisor/{auth,host-origin,service-app,paths}.ts`, backend/adapter/engine/cmd consumers, `bin/taskaside.js` only if path behavior must be kept aligned.
- **Create:** `src/infrastructure/http/{auth,host-origin,service-app}.ts`, `src/infrastructure/paths/app-paths.ts`.
- **Input → output:** Existing host/origin/role/auth/path inputs → identical decisions/resolved paths. Separate HTTP credential verification from supervisor credential creation; shared code imports no application owner. Backend DB path opening remains backend-owned.
- **Adjustment:** Keep dynamic ports, browser/internal/MCP separation, Darwin app data, scratch dirs, installed payload paths, and role-specific recovery routes. Do not move Bun dependencies into Node bootstrap or browser code. Helpers already moved with earlier consumers are not extracted twice.
- **Verify:** `test:services`, `test:api`, `test:mcp`, `test:contracts`, `test:supervisor`.

### LC-11b — Launcher and package

- **Touch:** `bin/{taskaside.js,taskaside.d.ts,taskaside-mcp.js}`, `package.json`, `src/distribution/distribution-checks.ts`, `release-candidate-checks.ts`.
- **Create:** `bin/runtime.js`, `bin/payload.js` only to move existing resolution/copy logic, with Node-compatible imports and matching declarations/packaged files.
- **Input → output:** Node argv/package → stable payload + Bun CLI invocation; help/version still work before Bun app startup. MCP launcher keeps existing stdio/HTTP bridging semantics and permission boundaries.
- **Adjustment:** Preserve one npm package and copied runtime assets. Current same-version install reuses payload if `dist` exists; verify a fresh isolated install and compare built bytes so old 0.1.0 assets cannot stand in for current evidence. No publish, cache-directory deletion, auth changes, or unapproved toolchain updates.
- **Verify:** `test:distribution`, `test:release-candidate`, `npm pack --dry-run --json`, isolated installed-payload start/status/stop and public Intake → two-root execution.

### LC-11c — Check support and builds

- **Touch:** `package.json`, `tsconfig.json`, `vite.config.ts`, `src/contracts/contract-checks.ts`, `src/harness/{harness-checks,index}.ts`, owner check imports. `.github/workflows/ci.yml` is already staged for deletion; do not restore it in this slice.
- **Move DB-owning integration suites:** `src/execution-engine/{engine-checks,pool-checks}.ts` → `src/backend/checks/{engine-integration-checks,pool-integration-checks}.ts`; `src/frontend/{ui-checks,workflow-checks,browser-interaction-checks}.ts` → `src/backend/checks/{ui-integration-checks,workflow-integration-checks,browser-interaction-checks}.ts`; DB portion of `src/distribution/release-candidate-checks.ts` → `src/backend/checks/release-data-checks.ts`. Keep package script names and aggregate order; redirect script paths and all source-relative fixtures when moving.
- **Input → output:** Same 18 deterministic suite names plus browser/live/package checks → equivalent isolated coverage against new modules. The fixture-only ready-task helper currently in `task/tasks.ts` moves to `src/backend/checks/support/resolved-task-fixture.ts`; production creation remains message-first.
- **Adjustment:** DB imports/setup stay under backend even in check support. Contracts scanner fixtures may contain forbidden import strings but do not import them. Harness uses public contracts/fake services. Preserve all assertions, including 58 engine/14 pool baseline checks; new cases may increase counts. Current UI/workflow suites use API/source checks and are not substitutes for DOM interaction proof. No resurrection of removed benchmarks or CI files as a refactor prerequisite.
- **Verify:** `test:harness`, `test:contracts`, `test:distribution`, `test:engine`, `test:pool`, `test:ui`, `test:workflow`, `test:browser`; build and package-content inspection.

## LC-12 verifies actual boundaries and support

### LC-12a — Remove bridges and enforce layers

- **Touch:** `src/backend/domains/task/{runs,tasks,recovery,admission,context}.ts`, `src/backend/domains/chat/messages.ts`, old frontend/engine facades and every remaining importer, `src/contracts/contract-checks.ts`, `AGENTS.md`, `specs/ARCHITECTURE.md`.
- **Create:** `src/harness/import-boundaries.ts` for check-only resolved import analysis if splitting the existing scanner is needed. It uses the installed TypeScript resolver, including `@/*` from `tsconfig.json`, rather than a new dependency.
- **Input → output:** Resolved imports/re-exports/dynamic literal imports → enforceable owner/layer report. No runtime import of check helpers, backend DB modules outside backend, service→usecase edge, SQL in handler/service, or browser server dependency.
- **Adjustment:** Current scanner uses import-string substrings and exempts checks. Add negative resolved-path, alias, re-export, and check/runtime fixtures; compare runtime dependency graphs separately from integration composition. Remove duplicate models/constants only after their callers move; retain the recorded heartbeat timing unless separately changed.
- **Verify:** `test:contracts`, typecheck/lint/build; scan all service and UI bundle roots, Node launcher, and relocated integration fixtures.

### LC-12b — Final deterministic and installed acceptance

- **Touch:** Original tracker/evidence plus existing owner check suites only for scoped regressions.
- **Input → output:** Fresh source/build and disposable installation → recorded full deterministic, DOM, and package results. No completion from compile/source inspection alone.
- **Adjustment:** Run `check:deterministic` with all 18 suites and record counts; run `check` for typecheck/lint/format/build too. Repeat startup/pool three times after the final runtime change, as required by the MR plan. Verify unequal generations, every-root contention/release/quarantine, Intake outcomes, both HITL resume branches, restart/ACK ambiguity, and zero early notification.
- **Verify:** `bun run check`, `bun run test:browser`, `bun run test:release-candidate`; three fresh `test:startup`/`test:pool` runs and isolated install/lifecycle smoke. Existing `test:safety` includes opt-in live branches; inspect flags before running so deterministic checks remain fake-only.

### LC-12c — Darwin Codex and Claude evidence

- **Touch:** `src/agent-adapter/{codex-checks,claude-checks,safety-checks}.ts`, `src/distribution/release-candidate-checks.ts`, provider/runtime evidence and capability matrix. No unrelated driver change under an evidence-only card.
- **Input → output:** Exact installed provider/version/profile/package → separate pass/fail/not-run evidence for each provider. Executable presence and argv assertions do not establish write enforcement.
- **Adjustment:** Use disposable alpha/beta plus forbidden gamma: edit both allowed roots; prove direct file-tool and shell denials outside scope and via escaping symlinks; exercise completion/failure/cancel/timeout, surviving descendants, HITL and detached installed lifecycle. Record sanitized argv, profile, file diffs, root lock intervals, launch identity and stop result. CLI baseline tests need extra integration cases for these guarantees; their names alone are not sufficient proof. No screenshots or registered user repos. Scope changes in driver permission flags follow the separate MR-05 safety repair, with new live evidence.
- **Verify:** `test:codex`, `test:claude`, classified live safety branches, installed two-root workflow on Darwin arm64. A missing login or version-specific capability is a provider gate limitation, never a reason to bypass permissions.

### LC-12d / LC-12e — Dropped OS gates

- **Touch:** Original tracker/cards, README/support matrix as part of LC-00p.
- **Input → output:** Current explicit Darwin arm64 scope → historical Linux/Windows cards marked `dropped`, not `done` or `blocked`. macOS x64 is also outside support.
- **Verify:** Documentation/link review only; `test:cross-os` may remain as a diagnostic, but it is not a Linux/Windows release dependency. No deletion of platform code just to narrow the matrix.

### LC-12f — Local completion report

- **Touch:** Original layer plan/tracker/cards, `specs/ARCHITECTURE.md`, `AGENTS.md`, `README.md`, per-card evidence.
- **Input → output:** Verified cards + current provider/installed outcomes → concise local handoff, layout map, unchanged public contracts, intentional safety deltas/migrations, remaining limitations, rollback and next task.
- **Adjustment:** Complete only after required LC-12b/c evidence; dropped OS cards add no dependency. Report live/provider gaps as partial completion. Do not edit old evidence to make it appear current or use the MR-01-to-08 filename as proof of every gate.
- **Verify:** Validate all links, script paths, status/evidence claims, and zero mixed-version runtime assumptions. No commit, push, external message, or publication.
