# IR-04 Evidence: Recoverable Intake Outcome and Stop Lifecycle

## 1. Summary of Changes
- **Startup Admission Gate (`runtime.ts:reconcileOnStartup`)**:
  - Admission loop is blocked until all persisted runs are either rehydrated under verified active control or quarantined. Unhandled reconciliation/rehydration errors cause `reconcileOnStartup` to return `false`, triggering backoff retry instead of silently opening admission.
- **Recoverable Outcome Receipts (`manager.ts`, `service.ts`, `client.ts`)**:
  - Adapter preserves `run.outcome` (`RunOutcomeSchema`) upon termination (including verified stop proof, verification method, and parsed `intakeResult`).
  - Added endpoint `GET /internal/v1/runs/:id/outcome` and outcome field in run status.
  - Reconciler and dispatcher fetch `run.outcome` directly, recovering terminal Intake results across lost ACKs, SSE disconnects, or engine restart without relying on transient logs.
- **Purpose-Aware Recovery & Guard (`recovery.ts`, `reconciler.ts`)**:
  - `finalizeRun` explicitly rejects `purpose === 'intake'` with `request.status === 'done'` (`INVALID_TRANSITION`), preventing generic completion from bypassing Intake resolution.
  - Cancellations (`status === 'cancelled'`) of Intake runs are finalized cleanly after verified process-tree stop.
  - Reconciler routes Intake runs through `commitIntakeResult` or `failIntake`, never generic finalization.
- **Intake MCP Mint Guard (`dispatcher.ts`)**:
  - If `mintManagedMcpToken` fails, the Intake attempt fails immediately (`failIntake`) rather than silently proceeding in a degraded state without tools.

## 2. Executed Checks
- `bun run test:startup`: PASS (5/5 checks passed)
  - Proved A1 automatic MCP task progression.
  - Proved A3 independent checkout progression.
  - Proved A9 restart reconciliation without duplicate writer.
  - Proved A10 live task cancellation waiting for verified stop.
  - Proved A11 planner-scoped MCP token tool isolation.
- `bun run test:pool`: PASS (14/14 checks passed)
  - Proved P7 crash and lost ACK idempotency with durable receipts.
  - Proved P8 deadline contract persistence without resets.
  - Proved P9 timeout and unverified stop quarantining.

## 3. Result
- Status: **PASS**
- Recovery preserves run purpose, deadlines, and durable outcomes.
