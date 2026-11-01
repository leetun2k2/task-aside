# Evidence: LC-04d — Separate event ingestion and publication

## Outcome
Extracted event receipt queries, projection SQL, hashing/deduplication rules, and post-commit event hub publication:
- Repositories:
  - `src/backend/domains/task/repositories/event-receipt-repository.ts`: `findEventReceipt`, `insertEventReceipt`.
  - `src/backend/domains/task/repositories/run-repository.ts`: `refreshRunHeartbeat`.
  - `src/backend/domains/chat/repositories/message-repository.ts`: `upsertAgentCompletedMessage`.
- Services (`src/backend/domains/task/services/event-service.ts`):
  - `validateEventRunId`: Validates event runId matches request runId.
  - `evaluateReceiptAction`: Evaluates receipt status; returns `idempotent-skip` for identical hash retries, throws `SEQUENCE_CONFLICT` for differing payload at same sequence, or returns `persist`.
- Usecase (`src/backend/usecases/ingest-events-usecase.ts`):
  - `ingestEventsUsecase`: Coordinates run ownership/fencing assertions, atomic receipt + state writes inside a transaction, and strictly post-commit fan-out to `eventHub`. If the transaction rolls back, no event is emitted to `eventHub`.
- Handlers & Callers:
  - `src/backend/api/runs.ts`: `POST /internal/v1/runs/:id/events` delegates directly to `ingestEventsUsecase`.
  - `src/backend/domains/task/events.ts`: `ingestEvents` delegates to `ingestEventsUsecase`.

## Affected Owners / Files
- `src/backend/domains/task/repositories/event-receipt-repository.ts` (new)
- `src/backend/domains/task/services/event-service.ts` (new)
- `src/backend/usecases/ingest-events-usecase.ts` (new)
- `src/backend/domains/task/repositories/run-repository.ts` (updated)
- `src/backend/domains/chat/repositories/message-repository.ts` (updated)
- `src/backend/domains/task/events.ts` (updated)
- `src/backend/api/runs.ts` (updated)
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-04d.md`

## Executed Checks and Results
1. `bun run typecheck`: Passed (clean, no TS errors)
2. `bun run lint`: Passed (168 files checked, 0 errors)
3. `bun run test:events`: 13/13 passed (0 failed)
4. `bun run test:projection`: 26/26 passed (0 failed)
5. `bun run test:contracts`: 32/32 passed (0 failed)

## Rollback
To roll back this slice:
- Revert changes to `src/backend/api/runs.ts`, `src/backend/domains/task/events.ts`, `src/backend/domains/chat/repositories/message-repository.ts`, and `src/backend/domains/task/repositories/run-repository.ts`.
- Remove `src/backend/usecases/ingest-events-usecase.ts`, `src/backend/domains/task/services/event-service.ts`, and `src/backend/domains/task/repositories/event-receipt-repository.ts`.

## Next Task
LC-05a: Extract atomic admission and claims.
