# Audit evidence and technology choices

## TL;DR

- **Goal:** Ground the proposed scope in inspected code and current primary documentation.
- **Key decision:** Distinguish static findings, executed checks, and unmeasured performance.
- **Impact:** Supports scope selection; this is not a full security audit or release certification.

**Historical baseline:** This file records the initial planning audit. Full scope was subsequently approved in the [overview](00-overview.md); implementation evidence belongs to the [task tracker](03-execution-plan.md) and its per-task records. The commands below were run during the initial audit, not rerun while preparing the handoff.

## Scope

### In scope

**Ready:** Record inspected findings, current build evidence, architectural constraints, and candidate technology trade-offs. Evidence was gathered on 2026-10-24 in the current checkout.

### Out of scope

Claims of measured runtime bottlenecks, dependency vulnerability assessment, real-provider verification, or Linux/Windows support. No application code was changed.

## Advanced

### Inspected findings

Static inspection supports the following findings. User-visible failure scenarios are acceptance targets to reproduce; they were not exercised in a browser during planning.

| Evidence | Finding | Scope |
|---|---|---|
| [App](../../src/frontend/App.tsx), 586 lines | Owns requests, message state, SSE listeners/reconnect, selection, grouping, mutations, keyboard actions, and modal state | R2, R4 |
| App message fetch/send handlers | Responses update one shared message array without checking the current task; requests are not aborted on selection changes | R2 |
| [Backend event projection](../../src/backend/domains/task/events.ts), App SSE handlers | Deltas carry run/message identity but no task ID; App accepts every delta and matches only message ID for append. Hub broadcasts to all subscribers | R2 |
| App completion/input/status handlers | Completion/input can clear any current transient stream. Status updates do not reject older versions; null `blockedReason` is replaced by the previous value through nullish fallback | R2 |
| [Frontend API](../../src/frontend/api.ts), [chat reads](../../src/backend/domains/chat/messages.ts), App | API exposes forward cursor pagination, default 50/max 200; App reads only the first page and ignores `nextCursor` | R2 |
| [Conversation](../../src/frontend/components/TaskConversation.tsx) | All loaded messages render; streaming reparses growing Markdown and requests smooth scroll on each content change. Status changes clear draft text | R2, R5 |
| [Markdown view](../../src/frontend/components/MarkdownView.tsx) | `marked` output passes regex replacements, then `dangerouslySetInnerHTML`. Regexes do not form a complete HTML sanitizer, including unquoted attributes and other URL forms | R1 |
| Frontend API token bootstrap | Stores URL token in session storage but does not remove it from the URL, contrary to specification §8.1 | R1 |
| [Stylesheet](../../src/frontend/index.css), 1,650 lines; [package manifest](../../package.json) | Existing color variables and responsive styles, plus many literal values and global rules. Tailwind/shadcn appear in desired docs but are absent from package dependencies | R3 |
| [Create dialog](../../src/frontend/components/CreateTaskModal.tsx), [settings dialog](../../src/frontend/components/SettingsModal.tsx) | Custom backdrop with `<dialog open>`; no inspected `showModal` or focus-trap management. Initial task/parent form state can outlive changed props | R3 |
| [Run domain](../../src/backend/domains/task/runs.ts), 922 lines | Admission, locks/fencing, yields, cancellation, contexts, heartbeat, finalization, and quarantine share one module | R4 |
| [Dispatcher](../../src/execution-engine/dispatcher.ts), 756 lines; [adapter manager](../../src/agent-adapter/manager.ts), 666 lines | Lifecycle and event/retry/process responsibilities are substantial; size alone does not prove defects or justify a generic framework | R4 |
| [Task domain](../../src/backend/domains/task/tasks.ts), [chat domain](../../src/backend/domains/chat/messages.ts) | Domain operations import `DomainError` from the HTTP API layer | R4 |
| [Task list](../../src/backend/domains/task/tasks.ts) | Unpaginated filtered task list; text search uses LIKE. This is a scale risk, not a measured slow query | R5 |
| [Workflow checks](../../src/frontend/workflow-checks.ts) | Exercises backend/fake-adapter paths and checks some UI behavior through source-text assertions; these do not verify DOM focus or stale browser requests | R7 |
| [Engine entrypoint](../../src/cmd/execution-engine.ts), [runtime](../../src/execution-engine/runtime.ts) | Runtime startup now launches scheduling and reconciliation. Historical handoff audit about missing polling must not be repeated as a current finding | R0 |

### Documentation conflicts to resolve in R0

- Root AGENTS links to root constitution/architecture/spec/plan files that actually live under `specs/` and the initialization folder. Several companion links also resolve relative to the wrong folder.
- The [original plan](../2026-10-18-initialize-project/PLAN.MD) says the checkout has no implementation. The checkout has services/UI and a newer handoff repair. Keep the old sequence as history, with current status clearly linked.
- Original docs describe numeric priorities and a default concurrency of three. Current [task contracts](../../src/contracts/task.ts) use P0–P3 strings, and the newer [pool spec](../2026-10-24-polling-worker-pool.md) defines capacity/deadline policy. Document and reconcile these deltas before changing related behavior.
- Original task creation describes provider selection, while current create input lacks it and uses repository defaults. Refactoring must not silently add provider selection as a new feature.
- The [handoff spec](../2026-10-24-handoff-single-writer.md) and pool spec contain their own evidence gates. Presence of implementation does not prove those gates passed in this planning session.

These observations do not amend governing documents. No process, persistence, or product boundary is being changed by this proposal.

### Commands actually run

| Command | Result | Establishes |
|---|---|---|
| `git status --short` before planning | Clean | No pre-existing tracked/untracked changes reported |
| `bun run typecheck` | Passed | Current TypeScript typecheck succeeds |
| `bun run build:ui` | Passed, Vite 5.4.21 | Production UI builds locally |

Build output: **231.63 KB JS / 71.09 KB gzip**, **22.41 KB CSS / 4.73 KB gzip**, excluding the small HTML file. Reported build duration was 461ms; this is a single warm local sample, not a benchmark. These numbers do not establish interaction performance. Output was written to ignored `dist/frontend`.

No application test suites, lint, browser checks, service builds, clean installs, runtime benchmarks, provider runs, or cross-OS checks were executed for this proposal. No unit tests or screenshots were created.

### Technology decision matrix

| Area | Recommended candidate | Reason / trade-off | Selection gate |
|---|---|---|---|
| Services and persistence | Retain Bun/Hono/SQLite and direct SQL | Fits local-first package and existing atomic ownership | Change only through explicit architecture approval |
| UI runtime | React 19 family; retain SPA/Vite | Incremental migration from declared React 18.3; not a promised performance gain | Matched React DOM/types and behavior checks; [official upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide) |
| Build tooling | Supported stable Vite/plugin pair | Existing Vite 5.4 needs a staged compatibility review | Latest migration guide targets Vite 8 from 7, so also review intervening guides and runtime/browser requirements; [Vite migration](https://vite.dev/guide/migration) |
| UI server data | TanStack Query v5 | Query keys, invalidation, cancellation, paged reads; adds cache policy | Pass AbortSignal to fetch; configure freshness, focus refetch, retries, and bounded cache explicitly; [cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation), [defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults) |
| Styling | Tailwind v4 + semantic tokens | Incremental utilities with consistent themes; existing CSS can remain during migration | Review browser floor: Chrome 111, Safari 16.4, Firefox 128; [compatibility](https://tailwindcss.com/docs/compatibility) |
| Controls | Selected shadcn/Radix Dialog, menu, button, field primitives | Editable accessible components; local code upkeep remains required | Verify the chosen primitive implementation and focus behavior; [model](https://ui.shadcn.com/docs), [Radix dialog recipe](https://ui.shadcn.com/docs/components/radix/dialog) |
| Chat Markdown | `react-markdown` + `remark-gfm`, raw HTML disabled | React rendering avoids the current HTML injection path; plugins still require review | Check URL behavior and plugin safety; use sanitation if HTML is ever enabled; [maintainer security guidance](https://github.com/remarkjs/react-markdown#security) |
| Local view state | React state | Existing scope does not demonstrate a second global state store need | Revisit only if real cross-workflow state cannot stay local |
| Large lists | Conditional windowing | Can reduce mounted DOM; complicates focus, scrolling, and variable heights | Profile first; no mandatory library adoption |
| Quality tools | Keep Biome lint + Prettier formatting | Their existing ownership is already distinct | Upgrade configuration only with the matching binary and a passing check |

Exact package versions are intentionally unselected. Manifest ranges are not proof of the installed versions; resolve and record the lockfile, runtime, platform, and peer-dependency matrix when R6 starts.

### Why a broader technology migration is deferred

PostgreSQL/Redis/GCP would introduce infrastructure and data migration beyond the stated local-first product. A Go rewrite would also require replacing Bun-specific persistence and revisiting one-package distribution. Next.js/SSR would add a rendering/server model without an inspected requirement for it. These are architecture alternatives to revisit if product deployment changes; none is a prerequisite for better UI or a justified performance improvement today.

The UI design search suggested landing-page patterns and oversized type. Those suggestions were discarded because they conflict with a dense task inbox and plain conversation. The proposed direction follows the inspected product instead.

### Requirement traceability

| Scope | Existing requirements / milestone |
|---|---|
| R0 | Constitution X; current docs and original M0–M6 status |
| R1 | Specification C-01, §8.1; PR-07; M5/M6 security |
| R2 | T-02, C-01, public REST/SSE §3, events §7; PR-07/08/10; M5 |
| R3 | T-02; PR-02/07/08/14/15; M5 |
| R4 | E-01/02/03, internal contracts §3, storage §6; PR-05/13; M2–M4 |
| R5 | PRD nonfunctional performance; pool spec; M4/M5 |
| R6 | Constitution VIII/X; M1/M6 |
| R7 | Specification verification §9; PR-11/12/13; M6 |
