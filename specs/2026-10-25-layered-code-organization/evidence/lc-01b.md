# Evidence: LC-01b — Record backend contract baseline

## Outcome
Baseline backend and contract suites executed and recorded. All contract assertions, persistence constraints, API endpoints, run lifecycle/fencing, event ingestion, scoped MCP dispatch, and browser projection tests passed with zero failures against temporary isolated databases. Wire shapes, error codes, query ordering, cursors, schema checksums, ownership invariants, and known coverage gaps have been cataloged.

## Affected Owners / Files
- `src/contracts/`
- `src/backend/`
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-01b.md`

## Executed Checks and Results
1. `bun run test:contracts`: 32/32 passed (0 failed)
2. `bun run test:db`: 13/13 passed (0 failed)
3. `bun run test:api`: 27/27 passed (0 failed)
4. `bun run test:runs`: 21/21 passed (0 failed)
5. `bun run test:events`: 13/13 passed (0 failed)
6. `bun run test:mcp`: 7/7 suites passed (0 failed)
7. `bun run test:projection`: 26/26 passed (0 failed)

Total: 139 checks passed, 0 failed.

## Contract Baseline Findings

### 1. Wire Shapes & Schemas
- **Task:** `{ id, repositoryId, title, description, status, priority, depth, parentTaskId, originRunId, originKey, createdAt, updatedAt, entityVersion }`
  - Valid statuses: `todo`, `processing`, `hitl`, `done`, `error`, `cancelled`.
  - Valid priorities: `P0`, `P1`, `P2`, `P3`.
- **Message:** `{ id, conversationId, role ('human' | 'agent' | 'system'), text, inReplyToRequestId, sourceRunId, sourceEventSeq, createdAt, entityVersion }`
- **Run Claim Request:** `{ ownerId, generation, idempotencyKey, taskId, targetWorkingDir }` -> returns `{ runId, taskId, ownerId, generation, canonicalWorkingDir, status, createdAt }`
- **Heartbeat Request:** `{ ownerId, generation }` -> returns `{ runId, status, refreshedAt }`
- **Finalize Request:** `{ ownerId, generation, terminalStatus ('done' | 'error' | 'cancelled'), verifiedStopped (boolean), verificationMethod, failureReason }`
- **Event Envelope:** `{ sequence, type, runId, taskId, timestamp, data }`
  - Hash is computed via SHA256 of canonical JSON (key order invariant).

### 2. Error Precedence & Codes
- `VALIDATION_ERROR` (400): Schema violations, invalid priority tokens, invalid status strings, missing required parameters.
- `VERIFIED_STOP_REQUIRED` (400): Finalize attempted with `verifiedStopped: false` on terminal status.
- `UNAUTHORIZED` (401): Missing or malformed Bearer token / pairing token.
- `FORBIDDEN` (403): Scopes disallowed, engine role attempting user actions (e.g. `clear-quarantine`), path traversal or static source access.
- `NOT_FOUND` (404): Unknown task, run, repository, or conversation.
- `LOCK_HELD` (409): Concurrent claim on identical canonical working directory or claiming a quarantined directory.
- `STALE_GENERATION` (409): Heartbeat, event ingestion, or finalize attempted with mismatched ownerId or stale generation number.
- `SEQUENCE_CONFLICT` (409): Ingestion of different payload at existing event sequence number.
- `REQUEST_ALREADY_RESOLVED` (409): Mismatched or duplicate HITL reply resolving `inReplyToRequestId`.

### 3. Query Ordering & Cursor Paging
- Runnable tasks: ordered by priority (`P0` -> `P3`) ascending, then `enqueued_at` ascending (FIFO within priority).
- Chat message paging: cursor-based pagination with stable opaque cursors, ordered chronologically.

### 4. Schema Version & Checksums
- Migration version tracked in `_migrations` table with migration names, execution timestamps, and SHA-256 checksums.
- Tampered checksums or versions higher than supported throw `IncompatibleSchemaError`.
- SQLite pragmas: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.

### 5. Ownership & Fencing Invariants
- Exactly one active writer per canonical repository path.
- Atomic claim: task claim, run insertion, and working-tree lock acquisition occur in a single immediate SQLite transaction.
- Generation counter strictly monotonically increments on every lock transition and never resets.
- Heartbeats do not release locks; uncertain runs quarantine locks; release requires verified stop evidence (`verificationMethod`).

### 6. Rollback Coverage Gaps Identified
- As documented in the main plan, external MCP `create_task` and MCP `request_input` execute in outer transactions while inner helpers emit event notifications or writes before the outer commit. These will be unified in LC-03b and LC-04c.

## Rollback
Documentation-only task; no code changes. Rollback is deleting this evidence file.

## Next Task
LC-01c: Record UI and lifecycle baseline.
