# Evidence: LC-05a — Extract atomic admission and claims

## Outcome
Separated task admission eligibility, capacity, and fencing rules from concrete database operations:
- Repositories:
  - `src/backend/domains/task/repositories/lock-repository.ts`: `getLockByKey`, `getLockForRun`, `upsertClaimLock`.
  - `src/backend/domains/task/repositories/claim-receipt-repository.ts`: `getClaimReceipt`, `insertClaimReceipt`.
  - `src/backend/domains/task/repositories/task-admission-repository.ts`: `findNextEligibleTaskId`, `countRunnableTasks`, `findRunnableTasks`.
  - `src/backend/domains/task/repositories/run-repository.ts`: `countActiveRuns`, `insertRunRecord`, `getRunById`, `requireRun`.
  - `src/backend/domains/task/repositories/task-write-repository.ts`: `markTaskProcessing`.
- Services (`src/backend/domains/task/services/admission-service.ts`):
  - Capacity calculation (`getEffectiveMaxConcurrency` enforcing 8-slot cap).
  - Validation rules: `assertCapacityAvailable`, `assertTaskClaimable`, `evaluateLockFencing`, `validateClaimReceiptTask`, `effectiveDeadline`, `buildClaimResponse`, and priority-ordered task ranking (`rankRunnableTasks`).
- Usecases:
  - `src/backend/domains/task/usecases/claim-task-usecase.ts`: Coordinates idempotency receipt verification, domain rule checks, immediate transaction (lock upsert, run insert, task status transition, receipt insert), and post-commit event publication (`task.status_changed`, `run.changed`).
  - `src/backend/domains/task/usecases/admit-next-task-usecase.ts`: Reconciles blocked parents, checks capacity ceiling, finds candidate task via indexed SQL, and delegates to `claimTaskUsecase`.
  - `src/backend/domains/task/usecases/list-runnable-tasks-usecase.ts`: Reconciles blocked parents, fetches runnable tasks, and sorts by priority then enqueued timestamp.
- Handlers & Bridges:
  - `src/backend/api/runs.ts`: Internal routes `/internal/v1/tasks/runnable`, `/internal/v1/tasks/:id/claim`, `/internal/v1/tasks/admit` delegate to their respective usecases.
  - `src/backend/domains/task/admission.ts`: Thin bridge delegating `claimTask`, `admitNextEligibleTask`, and `listRunnableTasks` to usecases for backward compatibility with external/engine callers.

## Affected Owners / Files
- `src/backend/domains/task/repositories/lock-repository.ts` (new)
- `src/backend/domains/task/repositories/claim-receipt-repository.ts` (new)
- `src/backend/domains/task/repositories/task-admission-repository.ts` (new)
- `src/backend/domains/task/services/admission-service.ts` (new)
- `src/backend/domains/task/usecases/claim-task-usecase.ts` (new)
- `src/backend/domains/task/usecases/admit-next-task-usecase.ts` (new)
- `src/backend/domains/task/usecases/list-runnable-tasks-usecase.ts` (new)
- `src/backend/domains/task/repositories/run-repository.ts` (updated)
- `src/backend/domains/task/repositories/task-write-repository.ts` (updated)
- `src/backend/domains/task/admission.ts` (updated)
- `src/backend/api/runs.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-05a.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, 0 errors)
2. `bun run lint`: Passed (175 files checked, 0 errors)
3. `bun run test:runs`: 21/21 passed (0 failed)
4. `bun run test:api`: 27/27 passed (0 failed)
5. `bun run test:pool`: 14/14 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/runs.ts`, `src/backend/domains/task/admission.ts`, `src/backend/domains/task/repositories/task-write-repository.ts`, and `src/backend/domains/task/repositories/run-repository.ts`.
- Remove new files: `lock-repository.ts`, `claim-receipt-repository.ts`, `task-admission-repository.ts`, `admission-service.ts`, `claim-task-usecase.ts`, `admit-next-task-usecase.ts`, `list-runnable-tasks-usecase.ts`.

## Next Task
LC-05b: Extract heartbeat ownership action.
