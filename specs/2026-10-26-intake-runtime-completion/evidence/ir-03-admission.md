# IR-03 Evidence: Atomic Reservations and Independent Fences

## 1. Summary of Changes
- Immediate SQLite transactions (`db.transaction(...).immediate()`) wrap candidate admission, eligibility checks, capacity checks, and lock writes in:
  - `src/backend/domains/task/usecases/claim-task-usecase.ts`
  - `src/backend/domains/task/usecases/claim-intake-usecase.ts`
  - `src/backend/domains/task/usecases/admit-next-task-usecase.ts`
- Implementation claims enforce all-or-nothing locking across all canonical paths in `task.resolvedRepoIds`. A busy or quarantined path aborts the transaction without holding partial locks.
- Candidate task discovery in `task-admission-repository.ts` verifies all resolved repositories for candidates, skipping tasks with held or quarantined paths while allowing independent work to progress.
- Receipt replaying for Intake claims does not query a repository since Intake operates on an app-owned scratch directory.

## 2. Executed Checks
- `bun run test:runs`: PASS (21/21 checks passed)
  - Proved all-or-nothing multi-root locks across canonical paths.
  - Proved capacity enforcement and non-stalling independent candidate selection.
- `bun run test:engine`: PASS (53/53 checks passed)
  - Proved contention resolution, non-preemption, and fencing.

## 3. Result
- Status: **PASS**
- No partial locks, no race window between capacity check and claim write, independent repositories progress without stall.
