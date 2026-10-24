# TaskAside — Engineering Constitution

> **Status:** Ratified MVP principles · **Version:** 1.0 · **Date:** 2026-10-18  
> **Authority:** Applies to application code, documentation, API contracts, tests, agent contributions and release decisions.  
> **Related:** [PRD.md](PRD.md) · [SPECIFICATION.md](SPECIFICATION.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AGENTS.md](AGENTS.md)

## Preamble

TaskAside exists so developers can **delegate coding tasks without personally supervising each terminal**. Its value is a reliable local queue, an understandable minimal interface, and safe execution of existing coding agents. It is not an AI model, general workflow engine, team project management product or remote orchestration platform.

Where simplicity conflicts with correctness in repository safety, **correctness wins**. Where complexity is merely speculative, **simplicity wins**.

## Non-negotiable principles

### I. Local-first and developer-controlled

1. Core scheduling, persistence, task UI and agent execution run on the developer's machine; no TaskAside-operated cloud service is mandatory.
2. Only explicitly registered local repositories may be used as agent working directories.
3. The developer can start, inspect status, stop and diagnose the app locally.
4. Model providers may require external authentication/network requests; never misrepresent this as fully offline inference.

**Enforcement:** Integration test with no TaskAside cloud services; explicit repository registration; `status` and `stop` operational commands.

### II. Single source of persistent truth

1. The **backend alone** opens/writes SQLite.
2. Task and chat are separate **domain schemas** within one database; do not copy mutable task state into execution-engine or agent-adapter.
3. All state transitions, working-tree claims, and durable message commits go through backend-owned domain logic and transactions.
4. In-memory SSE hubs and buffers are ephemeral delivery channels, never authoritative storage.

**Enforcement:** Static architecture checks/module boundaries; mutation integration tests; restart/reconciliation tests.

### III. Separation by responsibility, not microservices

1. `backend` owns **state**, `execution-engine` owns **scheduling and instructions**, and `agent-adapter` owns **provider runtime/process control**.
2. All three are independent background processes managed by one local supervisor, from one source repository and npm package.
3. Backend may not spawn coding agents; adapter may not decide task priority; engine may not connect directly to SQLite.
4. Internal HTTP is permitted only as defined by a shared versioned contract and authenticated role.

**Enforcement:** Tests may substitute fake backend or fake adapter; no cross-imports of private modules.

### IV. Safe execution before clever scheduling

1. At most one TaskAside-managed code writer per canonical working tree in MVP.
2. Claim/run creation/lock acquisition is atomic; operations verify owner and fencing generation.
3. A dead heartbeat alone does **not** prove that a subprocess has stopped.
4. Cancellation never releases a lock until stopped-process verification or explicit safe recovery.
5. Recovery must favor **blocking uncertain work** over launching a duplicate writer.
6. User messages cannot silently approve privileged provider actions.

**Enforcement:** Adversarial race, cancel, crash and restart tests, including Windows-specific process-tree handling.

### V. Minimal, focused interaction

1. A task list and a task conversation are the primary surfaces.
2. The sidebar groups simultaneously by state and priority with reversible nesting.
3. Chat is human/agent Markdown messages, not a terminal log or interactive approval-card UI.
4. Settings live behind avatar -> menu -> modal.
5. Keep Files/Subtasks/Activity tabs, Kanban, timelines, deadlines and analytics out of MVP unless the constitution is amended.

**Enforcement:** UI acceptance screenshots and an explicit check against [PRD.md](PRD.md).

### VI. Provider-aware and honestly interoperable

1. MVP integrates **Codex and Claude**, behind one agent-adapter REST interface with two driver implementations.
2. Never pretend providers support identical HITL, session persistence, or approval semantics.
3. Capability gaps must be explicit (capability checks, UI hints, fallback or blocked release), not patched with unsafe text parsing.
4. MCP exposes narrowly scoped task/chat actions to authorized external and managed agents. MCP is not a shortcut to runtime/admin privileges.
5. Prefer official documented integration paths, respecting credential and product usage terms.

**Enforcement:** Separate contract suites and live POCs for both providers; unsupported capability tests.

### VII. Structured operations, visible messages

1. A task creation, state change, cancellation or HITL request must have a structured operation and validation, regardless of how it is described in chat.
2. Only meaningful messages appear in chat. Raw logs are separate, bounded and redacted as practicable.
3. Managed agents creating child tasks must use task/run-scoped authorization, parent constraints and idempotency keys.
4. Parent-child relationships are organizational until explicit wait conditions are defined. Never infer dependencies from a task title.

**Enforcement:** MCP scope tests, duplicate creation tests, parent-cycle tests.

### VIII. Low operational burden and cross-platform parity

1. One published TaskAside npm package; the user starts with one command after documented prerequisites.
2. A stable detached supervisor must survive closing the launch terminal; ephemeral package cache is not an acceptable runtime dependency.
3. macOS, Linux and Windows are supported release targets; POSIX-only behavior is not permitted without Windows implementation.
4. No mandatory Docker, Redis, Postgres, Temporal, Restate, Kubernetes or message broker.

**Enforcement:** Clean-machine install/launch/stop/uninstall smoke tests on all OSes.

### IX. Test the state machine, not just happy-path endpoints

1. Every externally observable state transition has positive and negative tests.
2. Every internal mutation is idempotent where retries are possible (run events, claims, child task creation).
3. Scheduler, adapter and backend must support fake/mocked implementations for deterministic tests.
4. Do not add a feature that cannot be tested without a real provider; provider integration is a separate test layer.
5. Cross-process disconnect, reconnect and crash are normal scenarios, not edge cases postponed indefinitely.

**Enforcement:** CI suites enumerated in [PLAN.MD](PLAN.MD); release blocked on safety test failures.

### X. Small changes and transparent decisions

1. No abstraction or dependency without an identified present use case.
2. Prefer direct modules, typed contracts, straightforward SQL migrations and readable logging.
3. Record consequential deviations as short architecture decision records (ADRs) or update [ARCHITECTURE.md](ARCHITECTURE.md), [SPECIFICATION.md](SPECIFICATION.md) and tests together.
4. Do not silently implement non-MVP features as prerequisites.
5. Do not claim commands exist, providers support features, or packages are published unless verified.

**Enforcement:** PR review asks: why this module, why now, how tested, which contract changed?

## Preferred conventions (not absolute rules)

- Bun + TypeScript for services; Hono for HTTP; `bun:sqlite` for storage.
- React + Vite + Tailwind + shadcn/ui for web UI.
- Zod or equivalent lightweight schema validation for wire payloads.
- REST for app/internal commands; SSE for live event delivery; Streamable HTTP MCP for agent tools.
- One source repository and one package release; a small `src/cmd` set of entry points.
- Meaningful domain naming: `Task`, `Conversation`, `Run`, `Claim`, `WorkingTreeLock`, `AgentEvent`.
- Avoid ORM until actual query complexity justifies it.

A preferred technology can be replaced through an ADR if simpler, safer or measurably more portable. A **non-negotiable principle requires explicit constitution amendment**.

## Domain ownership rules

| Concern | Authoritative owner | Forbidden shortcut |
|---|---|---|
| Task state, priority, repo configuration | backend/task domain | engine SQL writes |
| Conversation and messages | backend/chat domain | adapter writing chat database |
| Scheduling and prompt building | execution-engine | backend assembling full prompts |
| Agent provider session and subprocess | agent-adapter | engine launching provider directly |
| UI grouping, chat display | frontend | frontend deriving state from raw process logs |
| Browser event delivery | backend event hub | shared memory across processes |
| Agent task tools | backend MCP | agent calling internal administrative endpoints |

## Definition of Done

A change is done only when:

1. It implements documented behavior with no accidental expansion of MVP scope.
2. Inputs, failure responses and security boundaries are validated.
3. Unit/integration tests cover success, invalid states and at least one failure/retry path for critical operations.
4. Cross-process communications and retry semantics are documented where affected.
5. Relevant public/internal/MCP contracts and docs are updated together.
6. No secret is added to code, test fixtures or user-visible logs.
7. Relevant OS and provider compatibility checks pass, or feature remains explicitly POC-gated and disabled.
8. The UI retains its minimalist two-pane task/chat philosophy.

## Review and amendment process

- Any contributor (human or coding agent) may propose an amendment with **reason, alternatives, migration impact, tests and docs changed**.
- Breaking domain/contract decisions require updating [ARCHITECTURE.md](ARCHITECTURE.md) and [SPECIFICATION.md](SPECIFICATION.md) before or in the same change.
- An MVP exclusion cannot be lifted because an agent found it easy to implement; it requires an explicit scope decision in [PRD.md](PRD.md).
- For contradictions, the constitution governs architecture principles, PRD governs intended product value, specification governs observable contracts, and architecture governs component design. Escalate rather than silently pick one.
- Version this document when principles change and note date and rationale. Avoid ceremonial governance for minor editorial fixes.

## Explicit non-goals

TaskAside is not a hosted SaaS, IDE, Git hosting platform, general workflow editor, session recorder for every token, or replacement for Codex/Claude themselves. Building those would contradict the current constitution unless consciously re-scoped.
