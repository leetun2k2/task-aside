# Evidence: LC-05c-p — Trustworthy stop evidence prerequisite

## Note on ordering

This card is not in the original `01-execution-plan.md` tracker table — it was introduced by `specs/2026-10-28-layered-refactor-continuation/01-lifecycle-cards.md` as a prerequisite inserted between LC-05b and LC-05c. Recorded here with the same evidence convention since the continuation plan's own ordering supersedes the original tracker for this range.

## Outcome

The agent-adapter was fabricating stop proof: every completion/error/cancel/timeout path stamped `verifiedStoppedAt`/`verificationMethod = 'process_group_empty'` unconditionally, regardless of whether the process group was ever actually confirmed empty. The execution-engine's own defensive logic (`dispatcher.ts`: poll for `verifiedStoppedAt`, else `markUncertain` — "never fabricate stop evidence") was already correct; it was simply being handed proof that was never genuinely verified. This slice fixes proof **production** at the source.

- `src/agent-adapter/drivers/process-group.ts`: rewritten to distinguish `ESRCH` (group confirmed empty) from `EPERM`/any other error (`uncertain` — never treated as empty). Split into `terminateProcessGroup` (active termination for cancel/timeout: SIGTERM→poll→SIGKILL→poll) and a new `verifyGroupAlreadyStopped` (passive verification for natural completion — no signal sent, since a direct child's own `close` event doesn't mean the whole group is gone, and signaling a possibly-recycled pgid would be unsafe).
- `src/agent-adapter/services/run-stop-service.ts` (new): `verifyNaturalStop(pgid)`, `stampVerifiedStop(run, result)` (only mutates `verifiedStoppedAt`/`verificationMethod` when `result.verifiedStopped === true` — otherwise leaves both `null`), and `resetLaunchProof(run)` (clears leftover proof before a new launch).
- `src/agent-adapter/state/launch-journal.ts` (new): crash-safe JSON file (not SQLite, no task truth, no instruction text — only `{launchId, runId, provider, payloadHash, pgid, startedAt, status}`) recording in-flight launches. `computePayloadHash` hashes `{provider, cwd, writeRoots, purpose, instructionLength}`.
- `src/supervisor/paths.ts`: added `getLaunchJournalPath()` (honors `TASKASIDE_DATA_DIR` like existing path helpers).
- `src/agent-adapter/drivers/types.ts`: added optional `onProcessGroupPid?(pgid)` callback so a driver can report the pid as soon as it's known.
- `src/agent-adapter/manager.ts`:
  - Constructor loads unresolved (`status: 'active'`) journal entries into `unresolvedLaunches`; `startRun` refuses to spawn over one (`RUN_UNCERTAIN`) until it's resolved (verified stopped via `cancelRun`, which clears the journal entry).
  - Repeated-start now also compares a payload hash against the active launch's recorded one; a changed payload (e.g. different `cwd`) is rejected (`VALIDATION_ERROR`) instead of silently replayed as idempotent.
  - `handleDriverEnd`/`handleDriverError`/`cancelRun`/`handleDeadlineTimeout` all now call `stampVerifiedStop` with a real verification result instead of stamping unconditionally; run status becomes `'uncertain'` (not `'done'`/`'error'`/`'cancelled'`) when the group can't be confirmed empty. `handleDeadlineTimeout` now `await`s `driver.cancel(run)` before stamping, instead of firing it with `.catch(() => {})` and stamping immediately.
- `src/agent-adapter/drivers/codex.ts` / `claude.ts`: report `onProcessGroupPid` once the pid is known; the `close` handler now awaits `verifyNaturalStop` before deciding terminal status, instead of stamping proof synchronously on the Node `close` event; `cancel()` only stamps when `terminateProcessGroup` actually confirms the group empty.
- `src/agent-adapter/drivers/agy.ts`: reports `onProcessGroupPid`; its close handler and `cancel()` were already deferring to the manager, which now verifies instead of fabricating. Its disabled Intake/multi-root guards in `manager.ts` are untouched.
- No wire-contract changes: `src/contracts/run.ts`, `src/execution-engine/{client,dispatcher,reconciler}.ts` were not modified — they already trusted `verifiedStoppedAt`/`verificationMethod` defensively; this slice only stops the adapter from lying to them. Confirmed by re-running `test:engine`/`test:startup`/`test:pool` unchanged (all still pass).

## Known gaps carried forward (documented, not silently dropped)

- **Escaped/reparented descendants are not solved.** A process that calls `setsid()` to leave the group, or is reparented to init before the group leader exits, is invisible to a pgid-based signal-0 probe. Catching that would require proactively tracking descendant PIDs from spawn time (this codebase doesn't do that) — a `pgrep`-based check was considered during design but rejected because it provides no real additional coverage over the existing `kill(-pgid, 0)` group check (both examine group membership; neither sees a process that changed its own group or was reparented). This remains a structurally hard, unsolved limitation, documented in `process-group.ts`'s header comment.
- **No wire-level `launchId`.** Kept internal to the agent-adapter per the card's "add launch binding only through the coordinated contract review" — out of scope here.
- **"A new launch clears a prior launch's leftover proof" (`resetLaunchProof`) has no dedicated new test.** There is currently no real call path in this codebase where the same `runId` gets a second real process launch (Codex doesn't support resume; Claude's resume creates a new `runId`; the only same-runId "resume" is the fake HITL scenario, which never touches `processGroupPid`/the journal). The reset is wired defensively for forward-compatibility but is not exercised by any existing or new test.
- `ps_fingerprint_absent` remains unused (unchanged from before this slice).

## Affected Owners / Files

- `src/agent-adapter/drivers/process-group.ts` (rewritten)
- `src/agent-adapter/services/run-stop-service.ts` (new)
- `src/agent-adapter/state/launch-journal.ts` (new)
- `src/supervisor/paths.ts` (updated: `getLaunchJournalPath`)
- `src/agent-adapter/drivers/types.ts` (updated: `onProcessGroupPid`)
- `src/agent-adapter/manager.ts` (updated: journal integration, verified stamping throughout)
- `src/agent-adapter/drivers/codex.ts`, `claude.ts`, `agy.ts` (updated: pid reporting; codex/claude close+cancel verify before stamping)
- `src/agent-adapter/adapter-checks.ts` (updated: 3 new checks — process-group alive/exited distinction, unresolved-journal-blocks-respawn, changed-payload-conflict)
- `specs/2026-10-25-layered-code-organization/evidence/lc-05c-p.md` (this file)

## Executed Checks and Results

1. `bun run typecheck`: Passed (clean, 0 errors)
2. `bun run lint`: Passed for all touched/new files (0 new errors; 16 pre-existing errors elsewhere, confirmed unchanged)
3. `bun run test:adapter`: 17/17 passed (14 existing + 3 new)
4. `bun run test:codex`: 8/8 passed
5. `bun run test:claude`: 12/12 passed
6. `bun run test:safety`: 11/11 passed
7. `bun run test:engine`: 58/58 passed
8. `bun run test:startup`: 5/5 passed
9. `bun run test:pool`: 14/14 passed
10. `bun run build:services`: Passed

## Rollback

To roll back this slice: revert `manager.ts`, `drivers/{process-group,types,codex,claude,agy}.ts`, `adapter-checks.ts`, `supervisor/paths.ts`; remove `services/run-stop-service.ts` and `state/launch-journal.ts`.

## Next Task

LC-05c: Extract `finalize-run-usecase` (backend), now able to trust `verifiedStopped`/`verificationMethod` from the adapter.
