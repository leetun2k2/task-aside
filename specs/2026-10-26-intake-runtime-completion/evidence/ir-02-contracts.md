# IR-02 Evidence: Explicit Run Protocol v2 & Migration 9

## 1. Summary of Changes
- Introduced `INTERNAL_PROTOCOL_VERSION = 'v2'`.
- Extended `StartRunRequestSchema` and `ClaimTaskResponseSchema` with typed fields:
  - `protocolVersion: z.literal('v2')`
  - `purpose: z.enum(['intake', 'implementation'])`
  - `writeRoots: z.array(z.string())`
  - `runFence: z.number()`
  - `lockGenerations: z.record(z.string(), z.number())`
  - `deadlineAt: z.string()`
- Added `RunOutcomeSchema` and added `outcome?: RunOutcome` to `RunStatusResponseSchema`.
- Implemented strict schemas for Intake outputs (`IntakeImplementResultSchema`, `IntakeDelegateResultSchema`, `IntakeRequestInputResultSchema`).
- Added DB migration 9 (`INTAKE_RUNTIME_COMPLETION_SCHEMA`) adding `admitted_scope`, `input_revision`, `policy_hash`, `terminal_outcome` to `runs` table.

## 2. Executed Checks
- `bun run test:contracts`: PASS (39/39 checks passed)
  - Proved strict rejection of extraneous unknown fields on Intake outcomes.
  - Proved v2 envelope serialization and validation.
- `bun run test:db`: PASS (13/13 checks passed)
  - Proved forward migration on fresh and existing DB.
  - Proved WAL mode, foreign keys, and unique indexes intact.

## 3. Result
- Status: **PASS**
- Version mismatches rejected; legacy schema upgraded cleanly; v2 contracts accepted end-to-end.
