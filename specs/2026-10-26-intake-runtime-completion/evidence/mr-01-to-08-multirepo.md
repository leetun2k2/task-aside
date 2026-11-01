# MR-01 through MR-08: Multi-Repo Execution and Scope Fencing Evidence

## 1. Scope & System Environment
- **Platform**: macOS Darwin 25.3.0 arm64 (Apple Silicon).
- **Target OS Policy**: Darwin arm64 only (per developer decision, Linux and Windows deferred release gates were dropped).
- **Tooling Versions**:
  - Bun: 1.4.3
  - OpenAI Codex CLI: 0.164.0
  - Claude Code CLI: 2.1.267
- **Governing Plan**: [03-multirepo-plan.md](../03-multirepo-plan.md) designed in coordination with Codex.

---

## 2. Implemented Capabilities and Architectural Changes

### MR-01: Scope Alignment & Capabilities
- Declared explicit `multiRoot: Boolean(codexPath && isDarwinArm64)` and `multiRoot: Boolean(claudePath && isDarwinArm64)` in `src/agent-adapter/capabilities.ts`.
- Guarded `startRun` in `src/agent-adapter/manager.ts` to reject multi-root runs for providers that do not support multi-repo execution (e.g. `agy`).

### MR-02: Complete & Atomic Multi-Repo Admission
- In `src/backend/domains/task/usecases/claim-task-usecase.ts`:
  - Resolved all repositories in `task.resolvedRepoIds`. If any resolved repo is missing from the database, fails immediately with `DomainError('NOT_FOUND')` rather than silently filtering it out.
  - Validated that canonical paths do not conflict or nest (e.g. parent/subdirectory relations).
  - Evaluated lock fencing atomically across all resolved canonical paths in an immediate SQLite transaction.
  - If any resolved repository is currently busy or quarantined, aborts the entire transaction with `LOCK_HELD` with zero partial locks held.
  - Replayed claim requests return the full admitted scope (`writeRoots`) and per-tree lock generations (`lockGenerations`).

### MR-03: Context Projections & Instruction Scoping
- In `src/backend/domains/task/usecases/get-task-context-usecase.ts` and `src/execution-engine/types.ts`:
  - Exposed `resolvedRepositories: Repository[]` on `TaskContext`.
- In `src/execution-engine/instruction-builder.ts`:
  - `buildInstruction` sets `Primary Working Directory` (`cwd`) and lists all `Allowed project roots`.
  - Guidelines enforce boundary notes: *"All actions must be contained within the allowed project roots (...). Do not inspect or modify directories outside this scope."*

### MR-04 & MR-06: Complete Fencing, Heartbeat & Stop Lifecycle
- In `src/backend/domains/task/recovery.ts`:
  - `heartbeat`: Refreshes leases atomically for ALL locks held by `runId` via `UPDATE run_locks SET lease_expires_at = ?, updated_at = ? WHERE owner_run_id = ?`.
  - `finalizeRun`: Releases all locks owned by `runId` and cleans up admitted scope paths atomically.
  - `markUncertain`: Quarantines all locks owned by `runId` and admitted paths atomically.
  - `clearQuarantine`: Clears quarantine only for locks where `owner_run_id = runId` or `owner_run_id = ''`, preventing stale recovery requests from clearing a successor run's lock.
- In `src/execution-engine/dispatcher.ts`:
  - `resumeHitlTask` preserves `writeRoots`, `runFence`, and `lockGenerations` across both provider resume branches (session resume and fresh turn resume).
- In `src/execution-engine/scheduler.ts` and `src/execution-engine/runtime.ts`:
  - In-memory `activeWorkingTrees` tracks all working tree keys held by multi-repo runs, preventing in-memory collisions.

### MR-05: Provider Command-Line Arguments & Profile Scoping
- In `src/agent-adapter/drivers/claude.ts`:
  - Placed `--add-dir <secondary_roots>` before subsequent option flags (`--permission-mode acceptEdits`, etc.) to prevent variadic directory arguments from absorbing the trailing prompt.
- In `src/agent-adapter/drivers/codex.ts`:
  - Passes `--approve-for-me` (which activates the `workspace-write` sandbox) and appends `--add-dir <root>` for each secondary repository.

---

## 3. Verification Evidence

### Deterministic Test Suites (`bun run check:deterministic`)
18 of 18 test check suites passed (100%):
1. `test:contracts` (39/39 checks passed)
2. `test:db` (13/13 checks passed)
3. `test:api` (27/27 checks passed)
4. `test:runs` (21/21 checks passed)
5. `test:events` (13/13 checks passed)
6. `test:mcp` (7/7 checks passed)
7. `test:projection` (26/26 checks passed)
8. `test:services` (19/19 checks passed)
9. `test:supervisor` (5/5 checks passed)
10. `test:harness` (11/11 checks passed)
11. `test:adapter` (14/14 checks passed)
12. `test:safety` (11/11 checks passed)
13. `test:engine` (58/58 checks passed, including the 5 dedicated multi-repo test checks):
    - `multi-repo: atomic claim acquires locks on all resolved repos, concurrent tasks on any resolved repo are blocked with LOCK_HELD`: **PASS**
    - `multi-repo: instructions and task context contain all admitted repos and boundaries`: **PASS**
    - `multi-repo: execution dispatch passes all write roots, heartbeat refreshes all leases, clean finalize releases all locks`: **PASS**
    - `multi-repo: uncertain stop quarantines all held repository locks`: **PASS**
    - `multi-repo: partial contention (one repo busy or quarantined) aborts entire claim atomically with zero locks held`: **PASS**
14. `test:startup` (5/5 checks passed)
15. `test:pool` (14/14 checks passed, P1 through P14)
16. `test:ui` (integration passed)
17. `test:workflow` (10/10 user workflow verification checks passed)
18. `test:distribution` (8/8 distribution and package verification checks passed)
