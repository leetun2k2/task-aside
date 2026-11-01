# Evidence: LC-03d — Unify cancel and retry entry actions

## Outcome
Unified task cancellation and retry actions across handler, usecase, service, and repository layers:
- Removed branching from HTTP handler `src/backend/api/tasks.ts`:
  - `POST /api/tasks/:id/cancel` delegates unconditionally to `cancelTaskUsecase(db, id)`.
  - `POST /api/tasks/:id/retry` delegates unconditionally to `retryTaskUsecase(db, id)`.
- Cancellation Usecase (`src/backend/domains/task/usecases/cancel-task-usecase.ts`):
  - Uses `classifyCancellation` rule.
  - Done or cancelled tasks return early as no-op.
  - Live tasks (`processing`, `hitl`) record cancel intent on the active run via `requestRunCancellationForTask` without prematurely releasing the lock until verified process stop.
  - Idle/queued tasks (`todo`, `error`) immediately transition to `cancelled`, persist status update, emit `task.status_changed` to eventHub, and reconcile blocked parents.
- Retry Usecase (`src/backend/domains/task/usecases/retry-task-usecase.ts`):
  - Validates retry rules via `validateTaskRetryRules`: only `error` tasks may be retried; rejects quarantined working trees with `LOCK_HELD`.
  - Resets status to `todo`, clears `blocked_reason`, updates timestamps and monotonic version, publishes `task.status_changed` event.
- Repositories (`src/backend/domains/task/repositories/task-write-repository.ts`):
  - Owns SQL updates: `cancelTaskRecord`, `retryTaskRecord`, `isWorkingTreeQuarantined`.
- Compatibility: `cancelTask` and `retryTask` in `src/backend/domains/task/tasks.ts` delegate to the new usecases.

## Affected Owners / Files
- `src/backend/domains/task/repositories/task-write-repository.ts` (updated)
- `src/backend/domains/task/services/task-service.ts` (updated)
- `src/backend/domains/task/usecases/cancel-task-usecase.ts` (new)
- `src/backend/domains/task/usecases/retry-task-usecase.ts` (new)
- `src/backend/domains/task/tasks.ts` (updated)
- `src/backend/api/tasks.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-03d.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (158 files checked, 0 errors)
3. `bun run test:api`: 27/27 passed (0 failed)
4. `bun run test:runs`: 21/21 passed (0 failed)
5. `bun run test:contracts`: 32/32 passed (0 failed)
6. `bun run test:pool`: 14/14 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/tasks.ts`, `src/backend/domains/task/tasks.ts`, `src/backend/domains/task/services/task-service.ts`, and `src/backend/domains/task/repositories/task-write-repository.ts`.
- Remove `src/backend/domains/task/usecases/{cancel-task-usecase,retry-task-usecase}.ts`.

## Next Task
LC-04a: Separate ordinary chat reads and writes.
