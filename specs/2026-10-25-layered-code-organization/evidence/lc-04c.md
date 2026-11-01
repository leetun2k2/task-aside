# Evidence: LC-04c — Unify input-required application action

## Outcome
Unified the input-required state transitions, message insertion, and post-commit event publication between adapter event ingestion and managed MCP `request_input`:
- Usecase (`src/backend/usecases/request-input-usecase.ts`):
  - `recordInputRequired`: Executes an atomic transaction updating `messages` (agent question), `runs` (`status = 'hitl', pending_input_request_id = requestId`), `tasks` (`status = 'hitl', updated_at = now, version = version + 1`), and `conversations`.
  - Publishes `input_required` and `task.status_changed` to `eventHub` only AFTER the transaction successfully commits. Nested message publication cannot escape rollback.
- Repositories:
  - `src/backend/domains/task/repositories/run-repository.ts`: `markRunHitl`.
  - `src/backend/domains/task/repositories/task-write-repository.ts`: `markTaskHitl`.
  - `src/backend/domains/chat/repositories/message-repository.ts`: `insertInputRequiredMessage`.
- Handlers & Callers:
  - `src/backend/mcp/tools.ts`: `executeRequestInput` enforces managed role authorization, then delegates to `recordInputRequired`.
  - `src/backend/domains/task/events.ts`: `input_required` ingestion delegates SQL updates to the explicit repository functions.

## Affected Owners / Files
- `src/backend/domains/task/repositories/run-repository.ts` (updated)
- `src/backend/domains/task/repositories/task-write-repository.ts` (updated)
- `src/backend/domains/chat/repositories/message-repository.ts` (updated)
- `src/backend/usecases/request-input-usecase.ts` (new)
- `src/backend/mcp/tools.ts` (updated)
- `src/backend/domains/task/events.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-04c.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (165 files checked, 0 errors)
3. `bun run test:events`: 13/13 passed (0 failed)
4. `bun run test:mcp`: 7/7 suites passed (0 failed)
5. `bun run test:runs`: 21/21 passed (0 failed)
6. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/domains/task/events.ts`, `src/backend/mcp/tools.ts`, `src/backend/domains/chat/repositories/message-repository.ts`, `src/backend/domains/task/repositories/task-write-repository.ts`, and `src/backend/domains/task/repositories/run-repository.ts`.
- Remove `src/backend/usecases/request-input-usecase.ts`.

## Next Task
LC-04d: Separate event ingestion and publication.
