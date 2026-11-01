# Evidence: LC-03a — Separate task and context reads

## Outcome
Separated task queries, projections, row mapping, and context assembly from domain mutations and removed cyclic barrel dependencies:
- Repositories: `src/backend/domains/task/repositories/task-query-repository.ts` owns SQL queries (`findTaskRowById`, `findActiveRunForTask`, `findActiveRunsForTasks`, `findTaskRows`, `findChildTaskSummaries`, `findConversationRow`), `TASK_COLUMNS`, and row mappings (`rowToTask`). Bulk active run lookup prevents N+1 queries.
- Usecases:
  - `src/backend/domains/task/usecases/get-task-usecase.ts`: Simple read `getTaskUsecase` and `requireTaskUsecase` (`usecase -> repository`).
  - `src/backend/domains/task/usecases/list-tasks-usecase.ts`: Simple read `listTasksUsecase` with filters, stable ordering, and active run resolution (`usecase -> repository`).
  - `src/backend/domains/task/usecases/get-task-context-usecase.ts`: Application action assembling TaskContext (task, repo, parent, conversation, bounded messages, child task summaries) without importing `runs.ts`.
- Decoupling: `src/backend/domains/task/context.ts` now delegates to `getTaskContextUsecase` directly, eliminating the circular dependency between `context.ts` and `runs.ts`.
- Handlers: `src/backend/api/tasks.ts` calls `getTaskUsecase` and `listTasksUsecase` directly for read endpoints.

## Affected Owners / Files
- `src/backend/domains/task/repositories/task-query-repository.ts` (new)
- `src/backend/domains/task/usecases/get-task-usecase.ts` (new)
- `src/backend/domains/task/usecases/list-tasks-usecase.ts` (new)
- `src/backend/domains/task/usecases/get-task-context-usecase.ts` (new)
- `src/backend/domains/task/context.ts` (updated)
- `src/backend/domains/task/tasks.ts` (updated)
- `src/backend/api/tasks.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-03a.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (151 files checked, 0 errors)
3. `bun run test:api`: 27/27 passed (0 failed)
4. `bun run test:runs`: 21/21 passed (0 failed)
5. `bun run test:projection`: 26/26 passed (0 failed)
6. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/tasks.ts`, `src/backend/domains/task/tasks.ts`, and `src/backend/domains/task/context.ts`.
- Remove `src/backend/domains/task/repositories/task-query-repository.ts` and `src/backend/domains/task/usecases/{get-task-usecase,list-tasks-usecase,get-task-context-usecase}.ts`.

## Next Task
LC-03b: Extract task creation.
