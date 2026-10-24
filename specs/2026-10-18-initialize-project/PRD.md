# TaskAside — Product Requirements Document

> **Status:** MVP baseline, approved product direction  
> **Version:** 0.3 · **Date:** 2026-10-18  
> **Tagline:** Hand off tasks. Stay in flow.  
> **Related:** [SPECIFICATION.md](SPECIFICATION.md) · [CONSTITUTION.md](CONSTITUTION.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [PLAN.MD](PLAN.MD)

## 1. Summary

TaskAside is a **single-developer, local-first task inbox and execution scheduler** for coding agents. A developer can submit tasks for one or more local Git repositories, choose Codex or Claude, and return only when input, review, or troubleshooting is needed. TaskAside owns the queue and conversations; existing coding agents own code generation and modification.

**Product promise:** One command to start, one focused web view to prioritize work, and hands-off execution when possible.

## 2. Problem and users

Developers currently juggle terminal windows, agent sessions, prompts, priorities, and conflicting edits across repositories. Some tasks can run in parallel; tasks that share a working tree must be serialized. Human questions interrupt execution, and context gets scattered among agent sessions. Existing project-management tools emphasize planning rather than managing actual local agent execution.

**Primary persona:** An individual developer using one machine and multiple local repositories with Codex and/or Claude Code. They understand Git and are willing to authorize agents to modify local code.

**Jobs to be done**

1. Capture tasks immediately without opening and supervising more terminals.
2. See all tasks grouped by **state and priority simultaneously**.
3. Let safe independent work run concurrently; avoid clobbering a shared checkout.
4. Respond to an agent in the task's **plain chat** when human input is needed.
5. Let an agent create child tasks for a larger scope and know which task they belong to.
6. Close the browser/terminal and still have the locally installed background services perform work.
7. Use either Codex or Claude under a single task system.

## 3. MVP experience

**Initial launch:** The user runs the future published command `npx taskaside`; a launcher starts or connects to a local supervisor, starts the three services, and opens the web UI. Node/npm is a prerequisite for `npx`. Application services run on Bun; the distribution must provision Bun or clearly require it. **This is the desired launch experience, not a claim that a package currently exists.**

**Main view:**

- Left **task sidebar** (not an app-navigation tree), with quick search, add task, grouping selector, collapsible two-level groups, concise task rows, and avatar at the bottom.
- Default grouping: **State → Priority**; switch to **Priority → State**. Both are true nested groups, not just sorting.
- States shown: `todo`, `hitl`, `processing`, `done`, `error`, `cancelled`. Prefer prominence for `hitl`, `error`, and high priorities; `done` and `cancelled` collapsed by default.
- P0 (critical), P1 (high), P2 (normal), P3 (low). Priorities drive dispatch order among runnable tasks.
- Right pane: selected task header (title, repo, priority, status, parent link if present), chronological **agent/user messages**, and a composer. Markdown/code blocks supported.
- No Files, Subtasks, Activity tabs, run cards, metrics panels, visual DAG, interactive approvals, or Kanban.
- Avatar opens a small menu with **Settings**; settings appear in a **modal** rather than persistent sidebar navigation.

**Example:** The developer submits two backend tasks and one frontend task. Backend tasks queue on the same working tree; frontend can run concurrently. An agent asks a question; the task moves to `hitl`. The developer replies in plain text and execution continues when safe. Another agent creates child tasks via TaskAside MCP and the parent/child relationship is navigable by task link.

## 4. Functional requirements

| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| PR-01 | Create, list, inspect, edit, cancel, and manually retry tasks | Must | Persisted after restart; invalid transitions blocked |
| PR-02 | Group task list by State → Priority or Priority → State | Must | Two collapsible levels; counts accurate |
| PR-03 | Persist repo mapping and constrain agent working directory | Must | Only user-registered local paths |
| PR-04 | Execute tasks by priority, FIFO tie-break, configurable global concurrency | Must | P0 before P1 when both eligible; repo guard respected |
| PR-05 | At most one TaskAside-managed writer per working tree | Must | Concurrent claim prevented transactionally |
| PR-06 | Two providers in MVP: Codex and Claude | Must | Both can start, emit messages, finish/fail, and cancel via one adapter API |
| PR-07 | Conversation per task with plain messages and Markdown/code | Must | User and agent messages survive restart |
| PR-08 | HITL: agent can request input; user reply re-queues/resumes safely | Must | No hidden auto-approval of unsafe actions |
| PR-09 | Agent creates child tasks via structured MCP operation | Must | Parent reference persisted; bounded depth/count |
| PR-10 | Serve frontend via backend; REST + MCP + SSE | Must | Browser receives live status and messages |
| PR-11 | Background processes survive closing browser/launch terminal | Must | `status`/`stop` available; no duplicate supervisor |
| PR-12 | One TaskAside npm package usable on supported OS/arch | Must | Smoke tests on macOS, Linux, Windows |
| PR-13 | Crash/restart handling for queues and uncertain runs | Must | Never blindly launch duplicate writer |
| PR-14 | Search tasks, link to parent/child by task ID | Should | Navigation without dedicated subtask view |
| PR-15 | Reorder priority and collapse preference persistence | Should | Restored after reopening UI |
| PR-16 | Structured logs for diagnosis | Must | Logs separated from chat; no full raw output in UI |

**Deadline scheduling:** explicitly omitted. No reminder or time-based execution beyond safety backoff/restart bookkeeping.

## 5. Scope boundaries

### Included

- Local-only, single developer, browser UI + Bun background services.
- Backend owns SQLite and serves frontend, REST, MCP, and SSE.
- Independent `execution-engine` and `agent-adapter` background processes coordinated by a CLI supervisor.
- Codex and Claude provider drivers **both in MVP**; validate actual capabilities with POCs, not invented uniformity.
- MCP accessible by user-authorized external coding agents and tightly scoped TaskAside-managed agents.
- Persistent task/chat models, simple parent/child relations, guarded scheduler, meaningful message streaming, retries by explicit user action.

### Explicitly out of scope

- Cloud hosting, team accounts, sync, remote worker fleets, containerized sandbox orchestration.
- General workflow engines, arbitrary DAG visual editors, advanced recurring tasks, deadlines.
- Git worktree creation, automated merge/rebase/PR workflows, cross-process shared memory.
- File browser/diff tab, Subtasks tab, Activity tab, cost dashboard, token analytics, Kanban/sprints.
- Third-party agent marketplace or generic plugin DSL.
- Guaranteed identical HITL semantics across providers; capability-aware differences must be documented.

## 6. Nonfunctional requirements

- **Availability:** Task states and completed messages survive unexpected process termination. In-flight work may require explicit recovery; safety outranks automatic continuation.
- **Concurrency:** Only TaskAside-controlled writers are prevented from simultaneous editing of the same canonical working tree. External user tools are not magically locked; make that limitation visible.
- **Security:** All HTTP listeners bind loopback, validate Host/Origin, authenticate write/internal/MCP operations, and enforce per-run permissions. No shell-string interpolation from prompts. Keep secrets out of chat/logs where possible.
- **Performance:** UI should remain responsive while agent runs. Batch token deltas; do not write every token to SQLite. Prove startup/resident memory with benchmarks rather than unsupported target numbers.
- **Portability:** Develop and prove feasibility on macOS first. Windows/Linux verification is required before cross-OS release, not before scaffolding. Process-tree cancellation, file paths, runtime selection and detached supervisor behavior must be tested per OS.
- **Maintainability:** One codebase, strict TS contracts, no distributed dependencies, small modules. Do not optimize for multi-user before evidence.

## 7. Success criteria and scenarios

A pilot is successful when a developer can: (a) install/start via one command on a supported machine; (b) register two local repos; (c) queue multiple tasks; (d) observe two distinct repos processing concurrently and one repo processing sequentially; (e) switch two-level grouping and read task chat; (f) use both Codex and Claude; (g) answer HITL through normal messages; (h) have an agent create a child task; (i) close/reopen browser without losing work; (j) restart after failure without duplicating an agent writer.

**Experience signals to observe during dogfooding:** number of times developers manually start a next agent; frequency of unclear `todo`/blocked states; percentage of runs requiring manual terminal interaction; recovery incidents; and time from user reply to resumed execution. These are measurement ideas, not invented targets.

## 8. Constraints and assumptions to validate

1. Codex App Server lifecycle, streaming, approvals, session recovery on each supported OS.
2. Installed Codex/Claude CLI authentication and Bun subprocess control, streaming and resume. Initial POCs use existing local CLI login/configuration following `z-agent-non-interactive`; separate API/SDK setup is not the default path. A fallback must not silently downgrade user safety.
3. Managed MCP client configuration and scoped credentials for both drivers.
4. A stable installed runtime/launcher outside ephemeral npx cache; process survival after terminal exit.
5. Cross-OS path canonicalization and cancellation of subprocess trees.

Unverified capabilities are **POC gates** in [PLAN.MD](PLAN.MD), not promises.

## 9. Dependencies and release gate

Feature delivery follows [SPECIFICATION.md](SPECIFICATION.md). Architecture decisions follow [ARCHITECTURE.md](ARCHITECTURE.md). Engineering changes must satisfy [CONSTITUTION.md](CONSTITUTION.md); agent contributors follow [AGENTS.md](AGENTS.md). The MVP is ready only when the acceptance matrix in [PLAN.MD](PLAN.MD) passes across supported OSes, including both providers.
