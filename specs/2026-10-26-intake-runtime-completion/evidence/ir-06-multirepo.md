# IR-06 Evidence: Full Multi-Repo Writer Lifecycle

## 1. Summary of Changes
- **Database & Locking (`src/backend/domains/task/`)**:
  - `task.resolvedRepoIds` contains the complete list of resolved repositories.
  - Multi-root locking acquires all canonical paths in `resolvedRepoIds` atomically or rolls back with no partial locks held.
  - All-or-nothing release and quarantine in `recovery.ts`: upon unverified stop or uncertain run, all locks owned by `runId` are marked quarantined.
- **Provider Driver Integration (`src/agent-adapter/drivers/`)**:
  - `buildClaudeArgs`: For implementation with multiple `writeRoots`, secondary roots (where `root !== run.cwd`) are passed via repeated `--add-dir <root>`.
  - `buildCodexArgs`: For implementation with multiple `writeRoots`, secondary roots (where `root !== run.cwd`) are passed via repeated `--add-dir <root>`.
- **Blocker Status on Live Multi-Repo Writes**:
  - Live execution of a harness simultaneously editing files across multiple git roots is kept disabled pending live-provider validation against upstream CLI permission models (per 01-contracts-and-lifecycle.md).
  - Single-repo execution remains fully operational and verified.

## 2. Executed Checks
- `bun run test:runs`: PASS (21/21 checks passed)
  - Proved all-or-nothing multi-root locks across canonical paths.
  - Proved that lock release cleans up all locks associated with a run.
- `bun run test:engine`: PASS (53/53 checks passed)
  - Proved single-writer working-tree serialization and alias canonicalization.

## 3. Result
- Status: **PASS (Deterministic Contracts & Drivers) / BLOCKED (Live Multi-Repo Execution Route)**
- Deterministic multi-repo contracts and argument mapping pass. Live multi-repo dispatch route remains safely disabled until per-provider multi-root permission evidence is captured.
