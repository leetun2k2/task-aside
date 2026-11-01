# Evidence: LC-04b — Extract HITL reply transaction

## Outcome
Extracted HITL reply coordination into an atomic cross-domain usecase spanning Chat and Task repositories:
- Usecase (`src/backend/usecases/reply-hitl-usecase.ts`):
  - Coordinates verification of conversation, pending HITL run, and request ID pairing.
  - Enforces `REQUEST_ALREADY_RESOLVED` if request ID is missing, mismatched, or already cleared.
  - Executes message insert, run resumption (`pending_input_request_id = NULL, status = 'running'`), task transition (`status = 'processing'`), and conversation timestamp update in a single atomic SQLite transaction.
  - Defers event publication (`message.completed` and `task.status_changed`) until AFTER the transaction commits.
- Repositories:
  - `src/backend/domains/task/repositories/run-repository.ts`: `findPendingHitlRun`, `resolvePendingHitlRun`.
  - `src/backend/domains/task/repositories/task-write-repository.ts`: `resumeTaskFromHitl`.
  - `src/backend/domains/chat/repositories/message-repository.ts`: `insertMessageRecord`, `touchConversationUpdatedAt`.
- Integration: `appendMessageUsecase` in `src/backend/domains/chat/usecases/append-message-usecase.ts` delegates to `replyHitlUsecase` whenever `inReplyToRequestId` is present.

## Affected Owners / Files
- `src/backend/domains/task/repositories/run-repository.ts` (new)
- `src/backend/usecases/reply-hitl-usecase.ts` (new)
- `src/backend/domains/task/repositories/task-write-repository.ts` (updated)
- `src/backend/domains/chat/usecases/append-message-usecase.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-04b.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (164 files checked, 0 errors)
3. `bun run test:api`: 27/27 passed (0 failed)
4. `bun run test:runs`: 21/21 passed (0 failed)
5. `bun run test:events`: 13/13 passed (0 failed)
6. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/domains/chat/usecases/append-message-usecase.ts` and `src/backend/domains/task/repositories/task-write-repository.ts`.
- Remove `src/backend/usecases/reply-hitl-usecase.ts` and `src/backend/domains/task/repositories/run-repository.ts`.

## Next Task
LC-04c: Unify input-required application action.
