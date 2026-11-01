# Evidence: LC-05b — Heartbeat ownership action

## Note on ordering

Per `specs/2026-10-28-layered-refactor-continuation/00-overview.md`, LC-05b is ordered behind LC-00p and LC-05a-r1/r2 (durable scope/fencing safety repairs). By explicit user decision, this slice implements LC-05b alone, on top of the current (unrepaired) single-run owner/generation fencing model. The durable full-tree-generation fencing model remains a known, documented gap (LC-05a-r1), unchanged by this slice.

## Outcome

Extracted heartbeat lease renewal out of `task/recovery.ts`'s inline implementation into a dedicated usecase, fixing the two concrete defects named in the card:
- Previously: `requireRun`/`getLocksForRun` read **before** a **default** `db.transaction()` (TOCTOU window between read and write).
- Now: run lookup, ownership/fencing check, and lock-count validation all happen **inside** `db.transaction(...).immediate()`.
- Previously: the lock lease update was raw SQL inline in `recovery.ts`.
- Now: it goes through a new repository method (`refreshLockLeasesForRun`), alongside the already-existing `refreshRunHeartbeat`.

- `src/backend/domains/task/usecases/heartbeat-usecase.ts` (new): `heartbeatUsecase(db, runId, request)` — reads run + locks, validates ownership/generation and lock-count inside `.immediate()`, then updates `runs.heartbeat_at` and every held lock's `lease_expires_at` via repositories. Public contract unchanged: `{ ok: true }` success, `NOT_FOUND`/`STALE_GENERATION` `DomainError`s. Lease duration stays the legacy 30s (`LEASE_DURATION_MS` from `runs.ts`), intentionally not unified with admission's 60s claim-lease duration.
- `src/backend/domains/task/services/run-ownership-service.ts` (new, minimal): `assertRunOwnership(run, ownerId, generation)` — the single-run owner/generation check moved out of `runs.ts`'s `assertFencingMatches`. This is **not** the full durable-scope service LC-05a-r1 would build; `finalizeRun`/`markUncertain` in `recovery.ts` still use the original `assertFencingMatches` from `runs.ts`, untouched in this slice.
- `src/backend/domains/task/repositories/lock-repository.ts`: added `refreshLockLeasesForRun(db, runId, leaseExpiresAt, now)`.
- `src/backend/domains/task/recovery.ts`: `heartbeat()` is now a thin forwarding export calling `heartbeatUsecase`, preserving the `runs.ts:378` re-export for any other internal caller.
- `src/backend/api/runs.ts`: `POST /internal/v1/runs/:id/heartbeat` now calls `heartbeatUsecase` directly instead of `heartbeat` from `recovery.ts`.
- Test coverage extended to assert lease timestamps actually advance (not just row counts/status), per the card's accept criteria:
  - `src/backend/run-checks.ts`: "heartbeat: succeeds..." now does a warmup heartbeat, then a measured heartbeat, and asserts `lease_expires_at` strictly advanced.
  - `src/execution-engine/engine-checks.ts`: the multi-repo heartbeat case now does a warmup heartbeat before capturing the baseline, then asserts both repos' leases advanced after the measured heartbeat.
  - Both needed a warmup heartbeat and a small delay before the measured call: the initial claim sets lock leases using admission's 60s duration, while heartbeat renews using the 30s duration, so comparing against the claim-time lease directly can make the lease appear to move backward on the very first heartbeat.

## Affected Owners / Files

- `src/backend/domains/task/usecases/heartbeat-usecase.ts` (new)
- `src/backend/domains/task/services/run-ownership-service.ts` (new)
- `src/backend/domains/task/repositories/lock-repository.ts` (updated: `refreshLockLeasesForRun`)
- `src/backend/domains/task/recovery.ts` (updated: `heartbeat` forwards to the usecase)
- `src/backend/api/runs.ts` (updated: route calls the usecase directly)
- `src/backend/run-checks.ts` (updated: heartbeat success case asserts lease advance)
- `src/execution-engine/engine-checks.ts` (updated: multi-repo heartbeat case asserts both leases advance)
- `specs/2026-10-25-layered-code-organization/evidence/lc-05b.md` (this file)

## Executed Checks and Results

1. `bun run typecheck`: Passed (clean, 0 errors)
2. `bun run lint`: Passed for all touched/new files (0 new errors; 16 pre-existing errors elsewhere in the repo, unrelated to this slice, confirmed unchanged before/after)
3. `bun run test:runs`: 21/21 passed (0 failed)
4. `bun run test:engine`: 58/58 passed (0 failed)
5. `bun run test:pool`: 14/14 passed (0 failed)
6. `bun run build:services`: Passed (backend.js, agent-adapter.js, execution-engine.js, cli.js all bundled)

## Rollback

To roll back this slice:
- Revert `src/backend/domains/task/recovery.ts`, `src/backend/api/runs.ts`, `src/backend/run-checks.ts`, `src/execution-engine/engine-checks.ts`.
- Revert the `refreshLockLeasesForRun` addition in `src/backend/domains/task/repositories/lock-repository.ts`.
- Remove new files: `heartbeat-usecase.ts`, `run-ownership-service.ts`.

## Known gaps carried forward (not addressed in this slice)

- No durable independent run fence / full-tree-generation model (LC-05a-r1) — `assertRunOwnership` still only compares the single run's `owner_token`/`lock_generation`.
- Two duplicate `RunRow` interfaces and two duplicate `getLocksForRun`/`getLockForRun` implementations (`runs.ts` vs. the repositories) still coexist; this slice only made the new usecase use the repository versions.
- `finalizeRun`, `yieldTask`, `markUncertain`, `clearQuarantine` (LC-05c/d/e) are untouched.

## Next Task

LC-05c-p: Trustworthy stop evidence prerequisite (per the continuation plan's stated order), or LC-05c directly if prerequisites continue to be skipped by explicit user decision.
