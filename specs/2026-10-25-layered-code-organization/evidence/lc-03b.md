# Evidence: LC-03b — Extract task creation

## Outcome
Task and conversation creation coordinated into a single transactional usecase with deferred post-commit event publication and support for atomic external MCP receipts:
- Repositories:
  - `src/backend/domains/task/repositories/task-write-repository.ts`: Direct SQL writes for tasks (`insertTask`, `countChildrenByParentId`).
  - `src/backend/domains/chat/repositories/conversation-repository.ts`: Direct SQL writes for conversations (`insertConversation`).
- Services: `src/backend/domains/task/services/task-service.ts`: Houses child task validation rules (`validateChildTaskRules`, depth and 5-child limits).
- Usecase: `src/backend/domains/task/usecases/create-task-usecase.ts`:
  - Executes conversation and task insert atomically in one SQLite transaction.
  - Supports `beforeCommit` hook allowing external callers (e.g. MCP external create_task) to insert external receipts in the same transaction.
  - Defers `eventHub.publish` until AFTER the transaction commits successfully. If transaction or receipt write fails, state rolls back and no browser event is published.
- Handlers & Callers:
  - `src/backend/api/tasks.ts`: Delegates `POST /api/tasks` directly to `createTaskUsecase`.
  - `src/backend/mcp/tools.ts`: External `create_task` uses `createTaskUsecase` with `beforeCommit` receipt write, ensuring atomicity and outer-commit publication.
  - `src/backend/domains/task/tasks.ts`: `createTask` delegates to `createTaskUsecase` for backward compatibility.

## Affected Owners / Files
- `src/backend/domains/task/repositories/task-write-repository.ts` (new)
- `src/backend/domains/chat/repositories/conversation-repository.ts` (new)
- `src/backend/domains/task/services/task-service.ts` (new)
- `src/backend/domains/task/usecases/create-task-usecase.ts` (new)
- `src/backend/domains/task/tasks.ts` (updated)
- `src/backend/api/tasks.ts` (updated)
- `src/backend/mcp/tools.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-03b.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (155 files checked, 0 errors)
3. `bun run test:db`: 13/13 passed (0 failed)
4. `bun run test:api`: 27/27 passed (0 failed)
5. `bun run test:mcp`: 7/7 suites passed (0 failed)
6. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/tasks.ts`, `src/backend/mcp/tools.ts`, and `src/backend/domains/task/tasks.ts`.
- Remove `src/backend/domains/task/repositories/task-write-repository.ts`, `src/backend/domains/chat/repositories/conversation-repository.ts`, `src/backend/domains/task/services/task-service.ts`, and `src/backend/domains/task/usecases/create-task-usecase.ts`.

## Next Task
LC-03c: Extract task editing.
