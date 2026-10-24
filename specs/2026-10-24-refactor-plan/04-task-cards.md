# Small task cards

## TL;DR

- **Goal:** Give Antigravity one bounded change and a clear pass condition per task.
- **Key decision:** Dependencies and status live in the [tracker](03-execution-plan.md); cards define outcomes and limits.
- **Impact:** Approved R0–R7 scope. No application work has started.

## Scope

### In scope

**Ready:** RF-01–RF-57. Each task inherits the tracker dependencies, stage gates, per-task evidence, and verification rules. Conditional performance work still requires assessment. Environment-dependent provider/OS tasks may become blocked with evidence.

### Out of scope

Unit tests, screenshots/videos, unrelated refactors, new product features, publication, and implicit changes to state/ownership policy.

## Advanced

Each card is one review slice. Split an oversized slice before implementing it; do not combine neighboring cards into one unreviewable change. `Verify` lists minimum evidence, not an exhaustive substitute for the acceptance document.

### RF-01 — Reconcile docs and accepted scope

- **Deliver:** Repair governing-document links and replace stale documentation-only status with an accurate current-state note. Link this approved handoff from the current plan/README without rewriting historical evidence.
- **Limit:** Preserve local-first architecture and product rules. List numeric-priority/provider-selection contract conflicts for resolution; do not change behavior based on an old example.
- **Verify:** Local Markdown targets resolve. Current status separates implemented code from unverified provider/OS gates. Record how each conflicting contract will be treated in this refactor.

### RF-02 — Inventory versions and safe commands

- **Deliver:** Record the lockfile-resolved dependency versions, actual Bun/Node/tool versions, OS, browser, and existing command coverage. Classify each check as in-process, fake subprocess, live provider, or cross-OS.
- **Limit:** Inspect setup/cleanup first. Use disposable data/repos and isolated ports; never launch the user's normal installation or run cleanup against arbitrary PIDs/paths.
- **Verify:** Every command in the tracker has a classification and safe invocation or a concrete blocking reason. Keep secrets and real login contents out of evidence.

### RF-03 — Record backend contract baseline

- **Deliver:** Run the existing backend/contract checks in disposable environments. Record REST/MCP/error shapes, message cursor direction, task ordering, event projection, and migration version/checksums.
- **Limit:** No production data and no migration changes. Do not treat an existing failing check as a passing baseline.
- **Verify:** Results for contracts, DB, API, runs, events, MCP, and projection are recorded. Ownership, duplicate events, stale replies, scope denial, and restart persistence have explicit coverage or named gaps.

### RF-04 — Record runtime process baseline

- **Deliver:** Run classified fake/process checks through actual service entrypoints where relevant. Record concurrent-run behavior, stop evidence, pool occupancy, restart recovery, and startup readiness.
- **Limit:** Both supported providers remain unchanged; fake runs must not start their real CLIs. Reuse the existing handoff/pool acceptance scenarios.
- **Verify:** Same-checkout writers do not overlap; different checkouts progress. Missing stop proof retains ownership. Record results of engine, startup, pool, adapter, safety, service, supervisor, and harness checks.

### RF-05 — Create browser interaction baseline

- **Deliver:** Establish a minimal browser interaction runner against isolated services with fake providers. Capture create/select/chat/dialog behavior and reproduce task-switch or stream-isolation defects through DOM/network assertions.
- **Limit:** Dev-only tooling is allowed. Disable screenshot, video, and image/trace screenshot capture. Do not replace source assertions with new unit tests.
- **Verify:** The runner works headlessly and records deterministic pass/fail steps. Known failures are named as open regressions, not hidden behind broad skips. Later cards must convert them to passing assertions.

### RF-06 — Record reproducible performance baseline

- **Deliver:** Create repeatable seeded disposable datasets for 1,000/10,000 tasks, 500/5,000 messages, and eight fake active runs across eight distinct registered checkout paths. Seed through backend-owned setup or its APIs. Measure build/transfer size, browser interactions, request counts, query timings, and per-process CPU/RSS.
- **Limit:** No real provider costs, user tasks, or performance-driven source changes. Record warm/cold conditions and measurement method; review feasibility of the initial budgets.
- **Verify:** Another run can recreate the datasets and compare p50/p95 on the recorded machine/browser. Preserve baseline numbers before upgrades. Dataset generation stays out of shipped runtime bundles.

### RF-07 — Resolve compatibility matrix

- **Deliver:** Select exact compatible Bun/types, TypeScript, React/DOM/types, Vite/plugin, lint/format, TanStack Query, Tailwind, shadcn/Radix, Markdown, and browser-check versions using current official docs and package metadata.
- **Limit:** Retain Bun/Hono/SQLite and the existing SPA. Confirm browser floor and each migration step. Do not assume a manifest range is an installed version.
- **Verify:** Record peer/runtime constraints, selected versions, migration order, and rollback for each upgrade. A genuine incompatibility blocks its dependent tasks; no silent removal of approved scope.

### RF-08 — Upgrade Bun and runtime types

- **Deliver:** Align the supported Bun runtime, runtime types, package/launcher expectations, and lockfile with RF-07. Keep existing storage and provider behavior.
- **Limit:** No other library major upgrades or historical migration edits. If a runtime change is unnecessary, record why the current supported version is retained.
- **Verify:** Typecheck, service builds, SQLite migration/reopen, subprocess cancellation, and packaged runtime resolution pass. Record the actual runtime used rather than only its package declaration.

### RF-09 — Upgrade TypeScript

- **Deliver:** Apply the selected TypeScript version and narrowly required strict-type fixes. Keep browser and service compilation boundaries clear.
- **Limit:** No broad type casts, `any`, disabled strictness, or runtime redesign to silence errors.
- **Verify:** Full typecheck and UI/service builds pass; changed types agree with runtime validation. Retained-version decisions require compatibility evidence.

### RF-10 — Upgrade React and matching types

- **Deliver:** Migrate React, React DOM, and matching types together to the selected React 19 version. Address required API/ref/effect compatibility.
- **Limit:** No new React architecture, compiler adoption, or concurrent redesign of task data.
- **Verify:** Build plus browser create/select/send/dialog smoke passes under StrictMode; effects clean up without duplicate streams or submissions. Record dependency compatibility.

### RF-11 — Upgrade Vite and React plugin

- **Deliver:** Follow applicable migration guides from the current Vite version to the selected supported version. Preserve static hosting paths and packaged asset resolution.
- **Limit:** No standalone production UI server, SSR, or backend routing redesign.
- **Verify:** Development smoke, production UI/service builds, static assets, SPA fallback, and package asset paths work. Record browser target and runtime requirements.

### RF-12 — Align lint and formatting tools

- **Deliver:** Upgrade or retain the selected Biome/Prettier pair with matching configuration. Keep Biome responsible for lint and Prettier for formatting.
- **Limit:** Do not suppress safety/accessibility rules globally. Keep required mechanical fixes in a separate bounded slice if large; no unrelated cleanup.
- **Verify:** Lint and format checks pass over their declared targets. Record prior failures and their resolutions. Markdown/link validation remains a separate check where format ignores docs.

### RF-13 — Add repeatable local and CI checks

- **Deliver:** Add one documented aggregate check command and a basic CI job reusing existing scripts. Separate deterministic checks from installed-provider and OS gates.
- **Limit:** Use the pinned runtime and frozen lockfile. Do not claim fake checks establish live-provider support or mask known regressions to get green CI.
- **Verify:** The aggregate command returns nonzero on a failed subcheck; the clean-install CI-equivalent run builds UI/services and records baseline failures explicitly.

### RF-14 — Replace unsafe Markdown rendering

- **Deliver:** Replace regex-cleaned HTML injection with the selected React Markdown/GFM rendering. Disable raw HTML, preserve safe links/code/tables, and use placeholders/links for remote images.
- **Limit:** No raw-HTML-enabling plugins or unsafe URL overrides. Document intentional rendering differences; remove `marked` only once no runtime consumer needs it.
- **Verify:** Browser fixtures cover unquoted event attributes, unsafe URL schemes, encoded forms, raw HTML, code fences, tables, links, and remote images. No script execution or unsolicited image fetch occurs.

### RF-15 — Complete browser token bootstrap

- **Deliver:** Persist the initial token once, then strip only its URL parameter. Preserve other query/hash state; report a recoverable storage/auth error without displaying the token.
- **Limit:** Preserve bearer auth, session storage, and current EventSource auth. Do not add a new session service or send the token to telemetry.
- **Verify:** Interaction checks cover initial access, reload, missing/invalid token, unavailable storage, and URL cleanup. Error evidence and logs contain no credential values.

### RF-16 — Type browser event projections

- **Deliver:** Define validated per-type browser payloads, add task identity to deltas, and add run identity to agent completions where the backend knows it. Keep human messages valid without a fabricated run.
- **Limit:** Additive browser contract only. Preserve provider/internal event envelopes, auth, event deduplication, and post-commit publication.
- **Verify:** Actual API/SSE integration covers every browser event type, simultaneous runs, human posts, malformed payload handling, and persisted completion. Document field additions and legacy-payload fallback.

### RF-17 — Support cancellation and validated reads

- **Deliver:** Pass AbortSignal through API reads and validate relevant response boundaries using browser-safe contracts. Preserve structured status/code/details for failures.
- **Limit:** Do not retry mutations automatically or replace existing endpoints. Cancellation must not cancel an agent run.
- **Verify:** Browser network checks delay/abort a task/message read and reject malformed responses. Failed/cancelled reads cannot replace a newer visible snapshot.

### RF-18 — Cache task and repository reads

- **Deliver:** Adopt TanStack Query for tasks/repositories with explicit keys, freshness, retry, focus-refetch, and cache limits. Keep search/group/selection preferences in view state.
- **Limit:** Do not add a second global store. Preserve backend list ordering and both nested grouping modes.
- **Verify:** Initial load, refetch, empty/error state, restored selection, and cache reuse pass. Duplicate initialization/reconnect requests are bounded and measured.

### RF-19 — Scope conversation reads by task

- **Deliver:** Key messages and loading/error state by task/conversation; consume the read cancellation signal and reject stale cross-task results.
- **Limit:** Do not yet change cursor semantics or render another task's previous data as the selected conversation.
- **Verify:** Delay A's read, switch to B, resolve A last; only B remains visible. Repeat with failed/aborted requests and fast A–B–A navigation.

### RF-20 — Isolate message sends and deduplication

- **Deliver:** Bind an in-flight send to its captured target. Reconcile REST/SSE completions by message ID and maintain per-target pending/error state.
- **Limit:** No optimistic persisted-message IDs or automatic mutation retries without an idempotency contract. Do not silently resend an uncertain write.
- **Verify:** Switch tasks while sending; race REST before/after SSE; receive duplicate completion. One committed message appears only in its conversation, and failed sends retain recoverable draft content.

### RF-21 — Move task actions onto server data

- **Deliver:** Integrate create/edit/cancel/retry with authoritative cache results and targeted invalidation. Keep repository additions synchronized with their consumers.
- **Limit:** Preserve existing legal transitions and provider selection policy. Do not mark a live task cancelled before backend stop verification.
- **Verify:** API/browser checks cover successful and rejected actions, repeated submit prevention, action completion after selection changes, and stale-generation/invalid-transition errors.

### RF-22 — Isolate live streams by task and run

- **Deliver:** Route transient content by task/run/message identity. Replace only matching transient messages on completion and ignore or reconcile unresolvable legacy deltas.
- **Limit:** Human posts, unrelated completions, and unrelated HITL events cannot clear another run's stream. Never treat delta text as authoritative task state.
- **Verify:** Interleave two or more runs, including reused message IDs across different runs. Task switching, completion, and input-required events never mix or erase unrelated content.

### RF-23 — Reconcile reconnects and task versions

- **Deliver:** Reconcile authoritative snapshots on connect/reconnect and detected gaps; prevent stale REST/events from rolling task versions backward. Apply explicit null clearing.
- **Limit:** Hub sequence may reset on backend restart and is not a durable entity version. Backoff/cleanup must not create duplicate subscriptions or request storms.
- **Verify:** Out-of-order snapshots/events, nullable block clearing, dropped connections, malformed events, and backend restart converge. Task creation/update events invalidate enough data to reveal rows missing from cache.

### RF-24 — Expose all existing chat pages

- **Deliver:** Consume the existing forward cursor with a clear load-more/progress/error path. Keep chronological order, stable identities, and scroll position while combining pages/live messages.
- **Limit:** Preserve current endpoint/default ordering. No latest-first endpoint, automatic full-history fetch, or message loss through page replacement.
- **Verify:** More than 50 and more than 200 messages are reachable; page retries, tied timestamps, duplicate/live arrivals, and task switching produce no gaps or duplicates in the requested history.

### RF-25 — Preserve task drafts and HITL behavior

- **Deliver:** Keep drafts isolated by task through status changes, failed sends, and task switching. Clear only the successfully submitted content. Show pending/resolved HITL behavior accurately.
- **Limit:** No approval auto-granting. Terminal task messages remain stored without restarting work; only the documented explicit retry path runs again.
- **Verify:** Type during processing, enter/leave HITL, switch tasks, fail a send, and receive a stale reply rejection. New input typed while an earlier send completes is preserved.

### RF-26 — Bound stream rendering and scrolling

- **Deliver:** Batch transient UI deltas with a bounded flush interval, avoid reparsing unchanged completed Markdown, and follow the bottom only while the reader is already following.
- **Limit:** Do not batch away persisted messages or delay control transitions behind animation. Clean timers/listeners on task switch, disconnect, and unmount.
- **Verify:** Burst output remains readable; a scrolled-up reader stays in place; explicit follow-latest works. Completion replaces pending content promptly, with measured render/request counts and reduced-motion support.

### RF-27 — Introduce tokens and both themes

- **Deliver:** Add the selected Tailwind setup and semantic colors, spacing, type, radius, focus, and motion tokens. Support light/dark/system preference with local persistence.
- **Limit:** Existing views may coexist during migration. Keep fonts local/system and avoid theme-specific literal colors in new views.
- **Verify:** Production CSS builds and both themes render without unreadable controls or theme flash. Preference, reload, system change, contrast, and reduced-motion behavior are checked through DOM/styles.

### RF-28 — Introduce accessible UI primitives

- **Deliver:** Add only the selected controls currently needed for buttons, fields, dialogs, menus, badges, and collapse. Choose one consistent shadcn/Radix approach.
- **Limit:** No bulk component dump, generic form factory, icon dependency, or new UI surface. Components remain simple and locally maintainable.
- **Verify:** Browser interactions establish labels, keyboard use, dialog focus trap/restore, Escape, background isolation, and disabled/pending semantics.

### RF-29 — Refresh inbox and grouping controls

- **Deliver:** Apply compact rows, search, create action, both nested grouping modes, counts, selection, collapse persistence, empty results, loading/errors, and footer menu.
- **Limit:** Preserve six statuses and P0–P3; no new navigation section or hidden task loss through collapsed/filtered state.
- **Verify:** Counts match the complete filtered task set; grouping and persisted collapse work after refetch/reopen. Keyboard and long-title/repo cases pass.

### RF-30 — Refresh task header and navigation

- **Deliver:** Present task title, repo, priority/state, parent/child links, block reason, and legal task actions consistently. Keep back navigation usable at narrow widths.
- **Limit:** No dedicated subtasks tree/tab or status derived from agent output. Pending cancel remains an accurate backend-owned state.
- **Verify:** Parent/child selection, missing linked data, long text, blocked reason clearing, action permissions, selection changes, and narrow-width back behavior pass.

### RF-31 — Migrate create-task dialog

- **Deliver:** Migrate creation to accessible primitives with explicit field/reset behavior and correct current parent/repository defaults whenever opened.
- **Limit:** Do not add unsupported provider input or silently create a task without a valid registered repo. Keep user-entered values after validation/network errors.
- **Verify:** Open/close/reopen, late-loaded repositories, changed parent selection, duplicate submit, failure correction, successful creation, and focus restoration pass.

### RF-32 — Migrate edit-task dialog

- **Deliver:** Migrate editing with fields bound to the intended task and a defined reset when the selected task changes.
- **Limit:** Keep API-authorized fields/transitions. A late response from task A cannot overwrite task B's form or cache.
- **Verify:** Switch selection while open/saving, reject an invalid transition, correct input, cancel/reopen, and save successfully with correct task identity and focus.

### RF-33 — Migrate settings and repository forms

- **Deliver:** Migrate settings, repository registration, provider default, concurrency help, and diagnostics to consistent modal/form states. Reuse authoritative server data.
- **Limit:** Keep the effective eight-slot cap and preserve saved lower limits. Do not add a permanent settings page or expose secrets/internal admin credentials.
- **Verify:** Fetch/save errors, repository errors, close/reopen, actual versus configured concurrency copy, diagnostics refresh, keyboard navigation, and focus restoration pass.

### RF-34 — Refresh conversation presentation

- **Deliver:** Apply readable chat/code, clear human/agent labels, composer, history controls, and plain HITL/queued/terminal/disconnected messages to the corrected data flow.
- **Limit:** Remove nonfunctional attachment controls and hard-coded personal names. No rich approval cards, raw logs, extra tabs, or decorative icons.
- **Verify:** All task states, Markdown fixtures, long code, empty/loading/error history, pending/failed sends, and input labels work in both themes.

### RF-35 — Verify responsive and accessible flows

- **Deliver:** Complete browser interaction/accessibility coverage for the full two-pane workflow at 375, 768, and 1440px, both themes, zoom, reduced motion, and keyboard-only navigation.
- **Limit:** Use DOM/style/network assertions, not screenshot comparison. Automated accessibility checks do not substitute for focus and screen-reader interaction checks.
- **Verify:** No page-wide overflow or inaccessible composer; every modal/menu has sound focus behavior. Text contrast and announcements are checked. Report any assistive-technology case not actually tested.

### RF-36 — Retire unused UI and CSS paths

- **Deliver:** Remove superseded fetching/SSE/view/style code only after migrated workflows pass. Keep feature concerns clear and root composition small without arbitrary line-count goals.
- **Limit:** Do not delete live selectors, keyboard behavior, preferences, or public exports merely because they appear old. No broad rename campaign.
- **Verify:** Typecheck/build, browser workflow regression, and production CSS/JS comparison pass. Remaining compatibility styles have a named consumer or reason.

### RF-37 — Decouple domain errors from HTTP

- **Deliver:** Make backend domain errors transport-independent while HTTP/MCP boundaries keep the same serialized codes, statuses, messages, and details policy.
- **Limit:** No error-code redesign or generic exception framework. Preserve valid cross-domain references without domain imports from the API layer.
- **Verify:** Actual REST/MCP requests reproduce validation, conflict, forbidden, not-found, and stale-generation responses. Domain imports no longer depend on transport handlers.

### RF-38 — Enforce service and browser import boundaries

- **Deliver:** Keep browser-safe types/validators separate from crypto/process/SQLite code and enforce forbidden cross-owner imports with a lightweight static check.
- **Limit:** No workspace/package split or shared runtime container. Support actual re-exports/type-only imports deliberately; do not move backend authority into contracts.
- **Verify:** The check accepts current legal imports and rejects a temporary isolated forbidden-import fixture. UI build contains no server-only dependency; only backend opens SQLite and only adapter starts providers.

### RF-39 — Separate run context reads

- **Deliver:** Isolate run/task context assembly and read projections from mutation responsibilities, preserving existing caller-visible results and authorization scope.
- **Limit:** No query tuning, reordered conversation, omitted pending input, or changed parent/child context as a side effect.
- **Verify:** REST/internal context and instruction-building integration return the same permitted task/repo/chat/parent data, including absent/invalid scope cases.

### RF-40 — Separate admission and ownership

- **Deliver:** Isolate atomic claim/admission, durable idempotency, capacity, and canonical checkout ownership as one coherent responsibility.
- **Limit:** Preserve transaction boundaries, generation checks, eight-slot cap, priority/FIFO, deadlines, and reservation during HITL/uncertainty. No generic lock manager.
- **Verify:** Through service/API contention, test duplicate admission, changed-key payload, lost ACK, same-path aliases, busy high-priority paths, multiple engine clients, and capacity reduction. No duplicate writer or over-admission.

### RF-41 — Separate finalization and recovery

- **Deliver:** Isolate heartbeat, yield/cancel/deadline completion, finalization, and quarantine/recovery responsibilities while preserving backend authority.
- **Limit:** No lock release from TTL, terminal text, caller-forged stop flags, or a sent signal. Do not rewrite historical migration statements/checksums.
- **Verify:** Race stale finalizers, duplicate terminal events, yield/cancel, successor ownership, expired leases, and uncertain adapter state. Only trusted verified stop releases the matching reservation once.

### RF-42 — Separate engine event delivery

- **Deliver:** Separate per-run SSE consumption, delta batching, persistent-event retry/ACK handling, and stream cleanup from dispatch setup where this clarifies ownership.
- **Limit:** Preserve original durable event tuples on retry, per-run isolation, bounded buffers, control request timeout, and SSE lifetime semantics.
- **Verify:** Interleaved output, lost backend ACK, sequence conflict, stream drop, malformed event, and abandoned monitor cleanup do not duplicate messages, mix runs, or respawn providers.

### RF-43 — Simplify engine lifecycle control

- **Deliver:** Clarify dispatch, HITL continuation, cancellation, timeout, startup reconciliation, and shutdown through direct named functions/guards.
- **Limit:** No generic orchestration framework, worker threads, scheduling-policy changes, or provider spawn in engine. Keep slow process work off the admission tick.
- **Verify:** Actual engine startup drives work; at most one admission per tick, full slots skip claims, HITL resumes once, unknown owners stay reserved, and shutdown respects drain/termination bounds.

### RF-44 — Separate adapter event subscriptions

- **Deliver:** Clarify per-run event sequence/buffer/subscriber lifecycle and isolate subscriptions from provider start/stop responsibilities.
- **Limit:** Preserve bounded best-effort replay, normalized event shapes, and adapter ownership of process state. Do not promise durable token replay.
- **Verify:** Slow/disconnected consumers, replay cursor, simultaneous runs, duplicate starts, and terminal cleanup keep bounded buffers and do not leak subscribers.

### RF-45 — Simplify adapter lifecycle callbacks

- **Deliver:** Replace deeply nested start/end/deadline/cancel callbacks with direct named lifecycle handlers where needed; keep Codex/Claude behavior distinct.
- **Limit:** No driver factory or provider-protocol migration. Stop proof must still identify the actual run/process tree; callback completion alone must not fabricate proof.
- **Verify:** Fake subprocess integration covers start failure, missing executable, timeout, cancel, exit/stop races, stale owner/generation, retained child process, and reused slot state for both driver paths.

### RF-46 — Separate check harnesses from runtime

- **Deliver:** Make verification code ownership clear and exclude it from runtime dependency graphs. Replace remaining refactor-affected source-string assertions with behavior checks.
- **Limit:** Relocate only affected harnesses and update their script paths together. No dozens of placeholder directories or rewriting unrelated existing tests.
- **Verify:** All documented check commands resolve, UI/process checks still exercise actual behavior, builds succeed, and packed service bundles contain no verification startup side effects.

### RF-47 — Profile the integrated refactor

- **Deliver:** Repeat RF-06 measurements on the final toolchain/UI/runtime. Attribute delays to requests, SQL, rendering, Markdown, or process control; list tuning candidates in priority order.
- **Limit:** Do not compare different datasets/hardware/warm conditions as a performance win. Do not introduce fixes in the profiling slice.
- **Verify:** Before/after data includes cached interaction p95, request volume, bundle transfer, CPU/RSS, and control latency. RF-48/RF-49 receive a concrete bottleneck or an evidence-backed no-op case.

### RF-48 — Tune measured backend read costs

- **Deliver:** Address the highest measured read/query bottleneck with the smallest change, or record `done — no-op` if no justified backend bottleneck exists.
- **Limit:** Prefer bounded queries/indexes without changing contracts. If measured scale needs pagination, first document an additive opt-in contract preserving existing array callers, full-filter group counts, stable cursor/selection, and rollback. No Redis/ORM or latest-history redesign.
- **Verify:** Compare query plan/timing and payloads on the same dataset; include filtering, counts, tied ordering, concurrent writes, and missing selected rows. New indexes use additive migrations; historical checksums stay unchanged.

### RF-49 — Tune measured list and Markdown costs

- **Deliver:** Address a measured browser bottleneck using bounded memoization, rendering, or windowing, or record `done — no-op` if budgets already hold.
- **Limit:** Add virtualization only with measured need and a selected compatible library. Preserve accessibility, variable-height content, full counts, browser find expectations documented honestly, and access to all requested history.
- **Verify:** Compare p95 interaction/render cost and DOM size on both datasets. Keyboard focus, selection, scrolling, live updates, and code blocks work after tuning; bundle cost is reported.

### RF-50 — Verify resource cleanup under churn

- **Deliver:** Run a 30-minute fake-provider churn scenario with repeated selection, send, stream/reconnect, completion, and cancellation. Fix any reproduced cleanup leak within its owner boundary.
- **Limit:** Keep backend reservations when process state is unknown. Never call leaked durable work a browser resource to clean up. Split multiple independent leaks into child tasks.
- **Verify:** Record heap/RSS trend, timer/listener/socket/subscriber counts, request volume, and post-idle behavior. No sustained unexplained growth or event processing after disposal.

### RF-51 — Complete CI acceptance coverage

- **Deliver:** Add the new browser, boundary, and relevant process/contract checks to the aggregate command and CI. Define required versus environment-gated jobs and time bounds.
- **Limit:** No tokens in CI, screenshots/videos, fake green OS checks, or live-provider invocation inside deterministic jobs.
- **Verify:** A frozen clean install runs lint/format/typecheck/build plus required deterministic checks. An injected failing browser/process assertion makes the job fail. Publish CI artifacts only through existing authorized CI behavior.

### RF-52 — Verify installed macOS payload

- **Deliver:** Build/pack and install in a disposable stable path using the documented launcher. Verify all three services and UI without source-checkout or ephemeral package-cache dependence.
- **Limit:** Do not publish, overwrite the user's live install, open a real repo, or broaden static-file access. Retain loopback/Host/Origin/auth restrictions.
- **Verify:** Start/status/stop, duplicate start, detached terminal lifetime, browser reconnect, version/asset checks, service startup failure, and safe stop pass. Record actual install paths with secrets removed.

### RF-53 — Verify backup and rollback

- **Deliver:** Document and exercise quiesce, SQLite-safe backup, compatible payload rollback, restart, and recovery using disposable data. Retain the previous known-compatible payload.
- **Limit:** A live WAL database cannot be safely backed up by copying only its main file. Use a consistent backup or verified stopped/checkpointed procedure. Never run an older binary on an incompatible schema or clear uncertain locks.
- **Verify:** Tasks/messages/receipts/ownership survive upgrade/rollback. Rejection of newer/tampered schema, interrupted upgrade, pending HITL, and uncertain ownership have explicit safe results.

### RF-54 — Smoke installed Codex workflow

- **Deliver:** Use the installed authenticated Codex integration with a disposable registered repo to prove normal installed startup → task → stream → durable completion and cancellation.
- **Limit:** No user repo edits, publishing, credential changes, paid-service setup, unsupported resume claims, or automatic privileged approvals. Follow actual current provider capability and harness guidance.
- **Verify:** Record CLI/runtime versions, redacted process/HTTP evidence, completion/cancel stop proof, and observed HITL/resume limits. Missing executable/auth/network blocks this gate with the exact reason.

### RF-55 — Smoke installed Claude workflow

- **Deliver:** Run the same installed end-to-end baseline independently through the existing Claude driver in a disposable registered repo.
- **Limit:** Do not infer success from Codex or fake fixtures. No SDK/CLI switch, auth changes, user repo edits, or privileged auto-approval.
- **Verify:** Record Claude/runtime versions, output/commit/cancel evidence, trusted stop result, and actual HITL/resume behavior. Missing access remains a blocked provider gate.

### RF-56 — Verify Linux and Windows targets

- **Deliver:** On actual target OS environments, run clean package installation, start/status/stop, detached lifetime, path identity, safe cancellation, and restart/uncertain-run checks. Fix reproduced portability defects within existing boundaries.
- **Limit:** macOS checks, cross-compilation, or mocked platform constants are not evidence of OS support. Do not provision paid infrastructure or claim untested provider/OS combinations.
- **Verify:** Publish the tested OS/architecture/runtime matrix and process evidence locally. Missing target access blocks that part of this task while completed local work stays valid; split platform fixes if necessary.

### RF-57 — Publish final local evidence report

- **Deliver:** Write a concise local report mapping R0–R7 and RF-01–RF-56 to evidence, before/after metrics, contract/doc deltas, upgrade/rollback steps, and remaining limits. Update tracker and current README status.
- **Limit:** Here `publish` means save in this repo, not upload or release. No done status for missing provider/OS gates. No code-line-count or passing-build substitute for behavior evidence.
- **Verify:** Final scoped checks pass after the last change, evidence links resolve, statuses match actual runs, and no forbidden features/dependencies or unit/image tests were added. If gates remain blocked, produce an interim report and keep full completion open.
