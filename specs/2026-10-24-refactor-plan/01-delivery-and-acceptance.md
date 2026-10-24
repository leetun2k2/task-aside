# Refactor delivery and acceptance

## TL;DR

- **Goal:** Make each selected refactor small enough to review and verify independently.
- **Key decision:** Finish observable workflows before expanding to runtime cleanup or advanced tuning.
- **Impact:** R1–R3 primarily affect browser behavior; R4 affects execution safety; R6–R7 affect every installed process.

## Scope

### In scope

All R0–R7 work in the [overview](00-overview.md) is selected. The outcomes below define acceptance. The [task tracker](03-execution-plan.md) gives the implementation order; [task cards](04-task-cards.md) bound each change. Exact versions and measured optimization choices are implementation outputs within the accepted direction.

### Out of scope

New product workflows, changes to provider capabilities, changes to queue policy, automatic task retries, and application implementation during this handoff-writing session. No unit tests or screenshots.

## R0 — Establish a baseline before moving code

**Outcome:** A reviewer can distinguish existing defects, intended behavior, and refactor regressions. **Dependency:** none. **Owners:** documentation, contracts, all touched services.

- Reconcile documentation-only status claims with the current implementation. Repair canonical documentation links and distinguish historical audit findings from current facts.
- Record installed/runtime versions, existing check results, bundle size, task-switch latency, query/request counts, and idle/active resource use. Use disposable data and repos.
- Map public REST, internal REST, MCP, browser events, and their consumers against existing TypeScript/Zod contracts. Record known mismatches rather than silently redesigning them.
- Capture required workflows: create/edit, grouping/search, chat history, concurrent streams, HITL, cancel/retry, reconnect, and restart.

**Exit:** A repeatable baseline with explicit failures and unverified cases. Existing handoff and worker-pool specs are inputs, not tasks to implement again. **Exclude:** application dependency upgrades and broad formatting churn. Minimal dev-only interaction/measurement tooling is allowed for the baseline.

## R1 — Close the inspected rendering and token gaps

**Outcome:** Untrusted chat cannot insert active HTML, and the bootstrap credential leaves the visible URL after storage. **Dependency:** R0. **Owners:** frontend; existing backend auth contract is preserved.

- Use `react-markdown` with GFM support and raw HTML disabled. Keep a restricted URL policy; plugins and custom renderers must not reintroduce active content. Treat remote images explicitly; use links/placeholders to avoid automatic third-party requests.
- Preserve normal Markdown, lists, tables, and code. Raw HTML compatibility is an intentional rendering change; retaining raw HTML is outside the accepted rendering direction.
- Consume the initial token once, store it in session storage, and remove only that query parameter while preserving other URL state. Show a recoverable auth error if storage fails. Keep tokens out of diagnostics.

**Exit:** Browser checks cover raw HTML, event attributes, unsafe URLs, normal Markdown, URL cleanup, reload, and unavailable storage. **Exclude:** a new auth/session model.

## R2 — Make task switching, history, and live updates correct

**Outcome:** One coherent view of backend state under delayed requests and concurrent execution. **Dependency:** R0; ship R1 before adopting its renderer in the final chat view. **Owners:** frontend, backend browser-event projection, shared contracts.

- Use task/conversation-scoped server-data caches with cancellation or stale-result rejection. Capture the send target so a late response cannot append to another task. Deduplicate REST and SSE messages by message ID.
- Model browser events by event type. Associate deltas with task, run, and message. Completed messages replace their matching transient content. An unrelated completion or input request cannot clear the selected task's stream.
- Treat SSE as invalidation and transient display. Refetch on connect/reconnect and detected gaps; reject older task versions. Clear nullable fields when the backend returns null. A backend restart resets hub sequence; it is not a durable entity version.
- Load all requested history through the existing forward cursor, keep chronological order, show progress/failure, and preserve the scroll anchor. Start with the current API; latest-first history would require a separate contract decision.
- Preserve the draft while task status changes. Do not force scrolling when the reader has scrolled up. Batch delta display; reconcile controls and committed messages promptly.
- Scope loading and errors to the affected workflow. Disable repeated submits while pending; do not invent retry idempotency for writes that lack it.

**Exit:** Two interleaved runs, rapid task switching, out-of-order REST responses, send/SSE races, more than 50 messages, malformed events, resolved HITL replies, and reconnect all converge to persisted state. **Exclude:** replacing the scheduler or provider protocol.

## R3 — Ship a coherent UI rather than a new product

**Outcome:** A compact, readable, keyboard-usable task workspace. **Dependency:** R0; final live acceptance depends on R2. **Owner:** frontend. **Selected:** desktop-first use, compact density, neutral surfaces, blue primary action, and light/dark themes. Narrow-width behavior remains required.

| Choice | Selected | Earlier alternative, not selected |
|---|---|---|
| Density | Compact task rows, clear selection, readable chat | More spacious rows for touch-heavy use |
| Visual language | Neutral surfaces, blue primary action, text labels for state | Choose another accent without changing behavior |
| Type and motion | System sans, monospace code, restrained motion | No remote-font dependency required |
| Foundation | Semantic tokens, Tailwind v4, selected shadcn/Radix controls | CSS Modules + accessible primitives if utility CSS is undesirable |

- Deliver inbox, header, chat/composer, and settings/create/edit dialogs as separate reviewable workflows. Keep parent/child navigation as links.
- Standardize spacing, type, colors, focus, errors, loading, empty search, and disconnected states. Use color with text, not as the sole status signal. Remove nonfunctional attachment affordances and hard-coded personal display names.
- Verify dialog focus trapping/restoration, Escape, background interaction, labels, screen-reader announcements, and form state after close/reopen or task changes.
- Preserve both grouping modes and collapse preferences. At narrow widths, show list/detail with a working back action; support zoom, reduced motion, and long code without page-wide overflow.

**Exit:** Interaction and DOM/accessibility checks at 375, 768, and 1440px, both themes, and keyboard-only use. Text contrast target: WCAG AA. Browser checks, not screenshots. **Exclude:** extra tabs, dashboard, rich approval cards, and decorative asset work.

## R4 — Simplify responsibility inside the current architecture

**Outcome:** Changes to transport, persistence, and run lifecycle have clear boundaries. **Dependency:** R0 plus passing process/contract evidence for each affected path. **Owners:** backend, engine, adapter, supervisor; frontend import boundaries.

- Keep frontend concerns grouped around inbox, conversation, and settings. Separate transport/cache behavior from view state; share only components used in real workflows.
- Keep domain errors independent of HTTP status mapping. Keep browser-safe contracts free of backend crypto/process dependencies.
- Separate backend admission/ownership, finalization/recovery, and context reads where their responsibilities differ. Keep each claim or release transaction intact.
- Separate engine event delivery/retry from dispatch lifecycle where useful. Adapter remains the only provider process owner. Do not introduce a generic workflow executor or driver factory.
- Separate executable verification harnesses from shipped application code where that makes ownership clearer. Replace source-text assertions with behavior checks as affected flows change. Add import-boundary checks to prevent forbidden cross-service imports.

**Exit:** Same-path contention, stale generation, ACK loss, cancellation, yield, deadline, adapter loss, and restart retain the same ownership guarantees. **Exclude:** changing three services, SQLite ownership, scheduling cadence/capacity/deadline policy, or provider drivers as a side effect.

## R5 — Optimize only what the baseline exposes

**Outcome:** A measured improvement without lost history, grouping counts, or safety. **Dependency:** R0, R2, and the relevant R3/R6 changes. **Owners:** whichever boundary owns the measured delay. Use the synthetic workloads below; record real-use differences before changing the measurement method. Assessment is required; an optimization no-op needs evidence.

| Workload | Measure | Initial acceptance budget; record feasibility in the baseline |
|---|---|---|
| 1,000 tasks, 500 messages, eight fake active runs | Search, task switch, typing, render commits | Cached interaction p95 ≤100ms on recorded reference hardware/browser |
| 10,000 tasks, 5,000 messages | Payload, query time, DOM size, scroll | No missing history; tune only the measured bottleneck |
| Repeated connect/disconnect and task switch for 30 minutes | Heap, listeners, sockets, request volume | No sustained resource growth after idle/collection |
| Production UI | Initial JS/CSS transfer and parse time | Review increases above 20% of baseline; increases need a stated benefit |
| Idle and eight fake active runs | Per-process RSS/CPU, admission/control latency | Record p50/p95 and compare on the same machine/data |

Candidate actions are bounded delta batching, cached Markdown rendering, reduced snapshot refetch, query/index tuning, and list virtualization. Virtualize only after profiling; preserve keyboard focus, variable-height chat, search, selection, and counts. If task pagination is needed, define full-filter group counts and selection outside the page before changing the API. Avoid fetching the whole backlog on every run event.

**Exit:** Before/after results include machine, browser/runtime, dataset, and measurement method. These are proposed budgets, not current performance claims. **Exclude:** worker threads, broker/cache services, speculative indexes, and automatic provider-session reuse.

## R6 — Upgrade dependencies through a compatibility gate

**Outcome:** A reproducible toolchain with verified runtime/browser support. **Dependency:** R0. **Owners:** frontend build, service runtime, distribution.

- Select supported stable versions at implementation time, pin the chosen runtime/toolchain policy and lockfile, and verify clean installs. Separate React/types, Vite/plugin, Bun/types, and lint/config migration reviews.
- Target the compatible React 19 version selected in RF-07; update React DOM and matching types together. Vite 5 needs the applicable migration steps; follow the selected supported upgrade path.
- Keep Zod/Hono unless an inspected compatibility issue requires a change. Keep existing Biome lint plus Prettier formatting ownership; avoid unrelated formatting churn or a second overlapping formatter.
- Prototype new UI dependencies against the selected browser floor before migrating screens. A toolchain upgrade has its own build/install gate, separate from performance claims.

**Exit:** Typecheck, lint/config, existing relevant checks, all service/UI builds, and packaged startup work with the chosen versions. **Exclude:** React Compiler, SSR, new state/router/form libraries without a current need.

## R7 — Make verification repeatable and upgrades reversible

**Outcome:** A small reviewed change can be installed and rolled back without corrupting state. **Dependency:** R0 and selected changes. **Owners:** CI, supervisor/distribution, affected services.

- Add a single documented check entry point reusing current commands. CI should typecheck, lint/format, build, and run selected contract/integration/fake-process checks. Keep live-provider checks separate and explicit.
- Browser automation should assert interaction, DOM, accessibility, and network behavior, with screenshot/video capture disabled. Source-string checks do not establish browser correctness.
- Upgrade only after stopping admission and safely draining/stopping writers. Never clear locks to make a deployment succeed. Quarantined or uncertain runs remain reserved.
- Build immutable release payloads, preserve the previous compatible payload, and record a SQLite backup/recovery procedure. Prefer no schema changes; any required migration is additive and separately reviewed. Never roll an older binary onto an incompatible schema.
- Verify installed static assets and all three services with no dependency on the source checkout. macOS is the local gate; actual Linux/Windows checks remain required before claiming cross-OS support. Do not publish as part of refactoring.

**Exit:** Selected behavior gates pass, packaged start/status/stop and restart are verified, and rollback preserves tasks/messages/ownership. A fake-provider pass does not establish real Codex/Claude compatibility.

## Contract and rollout limits

| Surface | Planned delta | Compatibility |
|---|---|---|
| Browser message events | Add task identity to deltas and run identity to agent completions; type event payloads | Additive backend projection; never fabricate a run for human messages. A client unable to resolve a delta discards it and refetches |
| REST task/message routes | Retain paths, payloads, ordering, and current cursor | Cache/render refactor does not require an API redesign |
| R5 task pagination or latest-history reads | Only if selected after measurement | New contract review required; preserve old callers or version the change |
| Internal REST / managed and external MCP | No semantic changes planned | Keep auth, scope, fencing, idempotency, and stop evidence |
| SQLite | No migration planned for R1–R3 | R4 must preserve transactions and existing durable ownership |

Existing schemas and functional specs are the starting contract. An OpenAPI projection is optional if it helps tooling, with an explicit synchronization direction from shared schemas; do not create two competing sources of truth. A runnable collection is useful only for selected cross-process checks. No Postman workspace setup or publishing is needed for this planning task.

For each slice, record selection ID, observable change, compatibility impact, checks actually run, and rollback. A failed ownership check blocks the affected runtime slice; an unverified provider or OS remains explicitly unverified.
