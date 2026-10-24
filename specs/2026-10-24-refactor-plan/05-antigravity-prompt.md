# Antigravity implementation handoff

Implement the approved TaskAside refactor in this repository. The user has selected **all R0–R7 scope**. Start work without asking for the same scope approval again. Implement one bounded task at a time and continue through the unblocked plan.

## Read these first

1. The repository's [AGENTS.md](../../AGENTS.md).
2. [Constitution](../CONSTITUTION.md), [architecture](../ARCHITECTURE.md), [specification](../2026-10-18-initialize-project/SPECIFICATION.md), and relevant [original milestones](../2026-10-18-initialize-project/PLAN.MD).
3. [Approved overview](00-overview.md), [acceptance rules](01-delivery-and-acceptance.md), and [audit evidence](02-audit-and-technology.md).
4. [Execution tracker](03-execution-plan.md) and [task cards](04-task-cards.md).
5. The newer [handoff safety](../2026-10-24-handoff-single-writer.md) and [worker-pool](../2026-10-24-polling-worker-pool.md) specs when working on execution.

The tracker is authoritative for refactor task status and dependencies. Start with the first unfinished unblocked task; initially **RF-01**. Historical documents contain stale status and some contract mismatches: follow the authority order, inspect actual contracts, and resolve/document contradictions rather than silently choosing code or old prose.

## Accepted scope and direction

- Retain Bun/TypeScript, Hono, backend-owned SQLite, React/Vite SPA, three service processes, persistent supervisor, and one npm package.
- Target compatible React 19, TanStack Query v5, Tailwind v4, selected shadcn/Radix primitives, semantic tokens, compact desktop UI, light/dark themes, and safe React Markdown/GFM with raw HTML disabled.
- Resolve exact supported versions in RF-07 from current official documentation; pin and verify them. No framework rewrite or cloud/database migration.
- Deliver corrected task/chat/SSE data flow, accessible forms and responsive UI, smaller runtime responsibilities, import boundaries, measured tuning, CI, and safe installed-package/rollback verification.
- Assess every performance candidate; apply only measured improvements. A conditional no-op requires recorded evidence.

## How to execute

Work serially in this checkout. Inspect relevant call chains before editing. For each task, set its tracker status to `doing`, make the smallest change, and run the matching checks. Keep internal design simple; filenames/functions are your choice within the documented owner boundaries. If a card contains multiple independent changes, split it into child IDs and update dependencies before implementation.

Create `evidence/RF-xx.md` inside this plan folder only when executing that task. Record outcome, changed boundaries, exact commands and results, resolved regressions, limitations, and rollback. Mark `done` only when acceptance evidence exists. Update the next task/checkpoint so another session can resume without repeating the audit. Existing planning files are user-approved work; preserve them and any unrelated uncommitted changes.

Use contract, integration, fake-subprocess, browser DOM/network/accessibility, and actual service-entrypoint checks. Existing scripts are inventoried in RF-02. Add no unit tests. Do not capture screenshots, video, or image traces. Do not use gitnexus. Never infer browser correctness from source-string assertions or provider support from fake fixtures.

Run checks in disposable data directories, ports, and Git repos. Do not test against the user's live TaskAside install or registered work repos. Never log secrets. Live-provider checks use existing permitted installations/auth only; do not create accounts, buy resources, change credentials, or grant privileged actions automatically.

## Invariants to preserve

- Only backend opens SQLite and owns task/chat mutations, claim/run/lock transactions, fencing, idempotency, and quarantine.
- Only engine owns scheduling/instructions; only adapter starts and controls provider processes. Keep 100ms admission cadence, eight-slot cap, one writer per canonical checkout, and existing deadline/control/shutdown policy.
- Never release ownership because heartbeat/TTL expired, an event says complete, a signal was sent, or an untrusted caller says the process stopped. Require trusted matching stop evidence.
- Keep six task states, P0–P3, two-level grouping, parent/child links, plain chat, and settings modal. No new tabs, Kanban, approval cards, analytics, or nonfunctional controls.
- Preserve REST/MCP/internal behavior unless the selected task explicitly defines a compatible delta. Add browser event identities without fabricating run IDs for human messages. Do not rewrite historical migrations/checksums.
- No generic executor/factory framework, nested callback chains, speculative abstractions, or unrelated refactoring. No commits, pushes, or publishing unless separately instructed.

## Failures and completion

Do not weaken checks, clear locks, or call existing failures passes. Reproduce a relevant failure and repair it within its owner boundary. A failed safety gate blocks dependent runtime work; unrelated safe tasks can continue. Record missing provider/OS access as `blocked`, continue independent work, and report exactly what remains unverified. Do not fabricate successful checks.

After each task, give a short outcome/check/next-task update. Finish with RF-57's local report: completed tasks, evidence-backed no-ops, blocked items, before/after metrics, verification commands, contract/doc changes, and rollback. Report local macOS, real Codex, real Claude, Linux, and Windows evidence separately. Do not claim full completion while required gates remain blocked.
