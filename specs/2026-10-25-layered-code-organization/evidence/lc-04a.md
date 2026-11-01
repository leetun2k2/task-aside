# Evidence: LC-04a — Separate ordinary chat reads and writes

## Outcome
Separated message reads and writes into explicit repository, service, usecase, and handler layers:
- Repositories (`src/backend/domains/chat/repositories/message-repository.ts`):
  - SQL data access and row mappings: `findConversationById`, `findTaskIdByConversationId`, `findConversationIdByTaskId`, `insertMessageRecord`, `touchConversationUpdatedAt`, `findMessagesPage`.
- Services (`src/backend/domains/chat/services/chat-service.ts`):
  - Cursor encode/decode rules (`encodeCursor`, `decodeCursor`) and pagination limit sanitization (`sanitizePageLimit`).
- Usecases:
  - `src/backend/domains/chat/usecases/list-messages-usecase.ts`: Simple read bypasses empty services (`usecase -> repository`), validates conversation existence, returns paged messages with stable nextCursor.
  - `src/backend/domains/chat/usecases/append-message-usecase.ts`: Coordinates conversation verification, transactional insert, `beforeCommit` hook support, and post-commit `eventHub.publish({ type: 'message.completed' })`.
- Handlers & Callers:
  - `src/backend/api/chat.ts`: Direct use of `listMessagesUsecase` and `appendMessageUsecase` for conversation and task routes.
  - `src/backend/api/runs.ts`: Internal task message append routes directly through `appendMessageUsecase`.
  - `src/backend/mcp/tools.ts`: Managed `get_messages` and `post_message` route through `listMessagesUsecase` and `appendMessageUsecase`.
  - `src/backend/domains/chat/messages.ts`: Preserves backward-compatible exports delegating to new layers.

## Affected Owners / Files
- `src/backend/domains/chat/repositories/message-repository.ts` (new)
- `src/backend/domains/chat/services/chat-service.ts` (new)
- `src/backend/domains/chat/usecases/list-messages-usecase.ts` (new)
- `src/backend/domains/chat/usecases/append-message-usecase.ts` (new)
- `src/backend/domains/chat/messages.ts` (updated)
- `src/backend/api/chat.ts` (updated)
- `src/backend/api/runs.ts` (updated)
- `src/backend/mcp/tools.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-04a.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (162 files checked, 0 errors)
3. `bun run test:api`: 27/27 passed (0 failed)
4. `bun run test:events`: 13/13 passed (0 failed)
5. `bun run test:mcp`: 7/7 suites passed (0 failed)
6. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/chat.ts`, `src/backend/api/runs.ts`, `src/backend/mcp/tools.ts`, and `src/backend/domains/chat/messages.ts`.
- Remove `src/backend/domains/chat/repositories/message-repository.ts`, `src/backend/domains/chat/services/chat-service.ts`, and `src/backend/domains/chat/usecases/{list-messages-usecase,append-message-usecase}.ts`.

## Next Task
LC-04b: Extract HITL reply transaction.
