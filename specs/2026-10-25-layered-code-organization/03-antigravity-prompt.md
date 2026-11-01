# Antigravity handoff: whole-repository layer refactor

Execute the TaskAside code-organization plan in this repository. The user has confirmed **whole-repository scope** and **simple reads may call repositories directly**. Start with the first unfinished unblocked task; initially **LC-01a**. Work through the plan without asking for the same scope confirmation again.

## Read first

1. [AGENTS.md](../../AGENTS.md).
2. [Constitution](../CONSTITUTION.md), [architecture](../ARCHITECTURE.md), [specification](../2026-10-18-initialize-project/SPECIFICATION.md), and [original milestones](../2026-10-18-initialize-project/PLAN.MD).
3. [Main layer plan](../2026-10-25-layered-code-organization.md), [execution tracker](01-execution-plan.md), and [task cards](02-task-cards.md).
4. [Single-writer safety](../2026-10-24-handoff-single-writer.md) and [worker-pool rules](../2026-10-24-polling-worker-pool.md) for run/lifecycle work.
5. The [previous roadmap overview](../2026-10-24-refactor-plan/00-overview.md) for context only. Its RF tasks are not this execution queue and their evidence is not a fresh pass.

## Confirmed design

Use `presentation → handler → usecase → service → repository` as the responsibility model. Simple reads may use `usecase → repository`. Add only real responsibilities; no empty forwarding services or folders.

- **Presentation:** React views and CLI output.
- **Handlers:** UI/REST/MCP/SSE input, commands, timers, and signals; parse, validate, delegate, map output.
- **Usecases:** One application action, resource authorization, coordination, and backend transaction scope.
- **Services:** Domain rules, scheduling/instructions, sessions, and lifecycle policy.
- **Repositories:** Explicit SQL/data access and concrete storage. HTTP clients, provider drivers, and process control keep their explicit I/O roles.

Keep owner roots and domain folders. Only backend opens SQLite. Keep one npm package, three service processes, the existing supervisor boundary, and the current Bun/TypeScript/Hono/SQLite/React/Vite stack. Shared server infrastructure imports no application owner; browser code imports no server implementation.

## Execute

Work serially in this checkout. For each task:

1. Read its card, inspect current implementation/callers, and check prerequisites and existing user changes.
2. Mark it `doing`. Make the smallest complete change across affected callers. Split oversized cards before editing.
3. Run the card's relevant checks and common type/lint/owner-build checks.
4. Write `evidence/<task-id>.md` in this folder with actual results, changed files, limits, rollback, and next task.
5. Mark `done` only after acceptance passes; update the tracker checkpoint. Give a short outcome/check/next-task update, then continue.

Use direct functions and explicit dependencies. Preserve current wire contracts, errors, defaults, CLI behavior, installed paths and capability limits. No generic framework, factory, ORM, new package, dependency upgrade, or unrelated cleanup. When API engineering skills are available, follow the applicable guidance using existing contracts; do not add a Postman workspace or publish artifacts merely for code extraction.

## Safety and compatibility gates

- Claim/run/lock and required Task/Chat/receipt writes stay atomic; preserve fencing and idempotency.
- Usecases define transaction scope; SQL stays in repositories. Publish notifications only after the outer commit; rollback emits nothing. Inspect the nested MCP publication risks recorded in the main plan.
- Preserve the eight-slot ceiling, one writer per canonical checkout, stable admission retry keys, deadlines and startup reconciliation.
- Never release ownership solely because TTL expired, a signal was sent, or an untrusted/terminal event claims completion. Require trusted matching process-stop evidence; quarantine uncertainty.
- Retain browser/internal/managed/external auth and scopes. No automatic privileged provider approvals.
- Keep two-pane UI, six statuses, P0–P3, both grouping modes, plain Markdown chat, task/run stream isolation, drafts and settings modal.
- Preserve deterministic fake-scenario injection when moving check support; fake checks must not start live providers.
- Keep the Node launcher runnable before Bun app startup; packaged installation must work without development source or ephemeral package cache paths.

## Verification and blockers

Use disposable databases, app-data dirs, ports and Git repos. Never test against the user's live install or registered work repos. Use contract, integration, fake-process, browser DOM/network, and real entrypoint checks. **Do not write unit tests, use gitnexus, or capture screenshots/video/image traces.**

Do not weaken assertions or call old/failed evidence a pass. Reproduce baseline defects; block only affected work and record a scoped repair. Preserve unrelated uncommitted changes. No reset/clean, commit, push, provider permission grants, or publication without separate instruction.

Run local fake/process checks first. LC-12c/12d/12e independently require actual Codex/Claude/Linux/Windows evidence. Missing access blocks that gate, not the remaining independent work. A declared CI matrix is not a native-OS result. LC-12f must report partial completion honestly when gates remain blocked.

Finish with a concise local report: task/evidence status, final owner/layer layout, checks actually run, failures and fixes, provider/OS limits, contract compatibility, rollback, and the exact next action for anything unfinished.
