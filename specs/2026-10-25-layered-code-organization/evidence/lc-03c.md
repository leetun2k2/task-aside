# Evidence: LC-03c — Extract task editing

## Outcome
Separated task editing into handler, usecase, domain rules, and SQL repository layers:
- Repositories: `src/backend/domains/task/repositories/task-write-repository.ts` owns `updateTaskRecord` executing parameterized SQL update with monotonic version increment.
- Services: `src/backend/domains/task/services/task-service.ts` houses `validateTaskEditRules` (rejects edits while processing) and `prepareTaskUpdate` (resolves defaults and timestamp).
- Usecase: `src/backend/domains/task/usecases/update-task-usecase.ts`: Coordinates task lookup, rules validation, SQL persistence, and post-update eventHub publication.
- Handlers & Callers:
  - `src/backend/api/tasks.ts`: PATCH `/api/tasks/:id` delegates directly to `updateTaskUsecase`.
  - `src/backend/domains/task/tasks.ts`: `updateTask` delegates to `updateTaskUsecase` for backward compatibility.

## Affected Owners / Files
- `src/backend/domains/task/repositories/task-write-repository.ts` (updated)
- `src/backend/domains/task/services/task-service.ts` (updated)
- `src/backend/domains/task/usecases/update-task-usecase.ts` (new)
- `src/backend/domains/task/tasks.ts` (updated)
- `src/backend/api/tasks.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-03c.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (156 files checked, 0 errors)
3. `bun run test:api`: 27/27 passed (0 failed)
4. `bun run test:projection`: 26/26 passed (0 failed)
5. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/tasks.ts`, `src/backend/domains/task/tasks.ts`, `src/backend/domains/task/services/task-service.ts`, and `src/backend/domains/task/repositories/task-write-repository.ts`.
- Remove `src/backend/domains/task/usecases/update-task-usecase.ts`.

## Next Task
LC-03d: Unify cancel and retry entry actions.
