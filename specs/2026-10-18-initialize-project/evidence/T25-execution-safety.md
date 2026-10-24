# T25 Evidence: End-to-End Execution Safety and Provider Verification

> **Milestone:** M4 Gate  
> **Date:** 2026-10-19  
> **Platform Tested:** macOS (Darwin arm64)  
> **References:** `SPECIFICATION.md` §2, §3, §6, §7, §8.1, §9; `ARCHITECTURE.md` §2.2, §4, §5, §6, §8, §9; `PLAN.MD` §7 (M4), §10 (Acceptance Matrix)

---

## 1. Executive Summary & M4 Gate Status

The M4 gate requires that T20–T25 pass completely and prove:
1. **Single Writer Invariant:** No scenario grants a second live writer on the same working tree.
2. **Missing Terminal Events:** Missing terminal events/messages strictly follow T05 recovery rules (quarantine or verified error) instead of reporting unproved success.
3. **Both Providers:** Both Codex and Claude drivers execute end-to-end through the engine dispatcher and scheduler.
4. **End-to-End Workflows:** Serialized same-tree writes, parallel distinct repos, HITL pause/reply/resume, child round-trip delegation, and explicit retry.

**Outcome:** M4 gate is **fully passed**. 53/53 engine checks pass cleanly in `src/execution-engine/engine-checks.ts`.

---

## 2. Execution Safety Verification Matrix

| Scenario | Specification Requirement | Verification Method | Result |
|---|---|---|---|
| **Serialized Same-Tree Writes** | PR-04, E-01: Working tree holds at most one active run; concurrent claims rejected with `409 LOCK_HELD`. | 2 tasks queued on same repo; Task 1 claims and executes; Task 2 attempt rejected with `all_trees_busy` and direct backend `409 LOCK_HELD`. Task 1 completes with verified stop; Task 2 is claimed under incremented generation. | **PASSED** |
| **Parallel Distinct Repositories** | PR-05, E-01: Tasks on distinct canonical repositories run concurrently up to max concurrency ceiling. | 2 tasks on distinct repos claimed concurrently; both trees marked busy; dispatched concurrently with `Promise.all`; both complete to `done`. | **PASSED** |
| **HITL Question & Chat Reply** | PR-08, E-03, C-01: `input_required` pauses run in `hitl`, retains repo lock, chat reply resumes execution. | Adapter emits `input_required`; dispatcher sets task/run to `hitl`, commits question to chat; tree lock strictly retained (concurrent claims rejected with 409); user replies in chat with `inReplyToRequestId`; execution resumes and completes with verified stop proof. | **PASSED** |
| **Parent/Child Delegation Round-Trip** | PR-09, E-02: Managed agent creates child via MCP, yields tree lock, child executes on same tree, parent unblocks. | Parent claims tree, mints managed MCP token, creates child, yields via `yield_task`; backend verifies stop proof, transitions parent to `todo` with `block_kind = 'children'`, releases tree lock; child claims same tree without deadlock, runs to `done`; parent automatically unblocks and resumes to completion under incremented generation. | **PASSED** |
| **Explicit Retry Lifecycle** | PR-13, State Machine: Failed runs release lock cleanly; error tasks not auto-rescheduled; explicit retry resets to `todo`. | Task fails on adapter; run finalized to `error` with verified stop proof; lock released; scheduler skips error task; `POST /api/tasks/:id/retry` resets to `todo`; scheduler claims with new `runId` and generation `+1`, running to `done`. | **PASSED** |
| **Adapter Crash Quarantine** | PR-04, §7: Adapter loss or crash without verified stop quarantines tree lock until supervisor override. | Adapter crash simulated; engine marks run uncertain (`POST /runs/:id/mark-uncertain`); backend sets `quarantined = 1`; subsequent claims on tree rejected with 409 `LOCK_HELD`; supervisor client calls `POST /runs/:id/clear-quarantine`; tree unblocks and executes pending work. | **PASSED** |
| **Codex Driver End-to-End** | PR-02, §6: End-to-end execution of Codex driver through engine dispatcher. | Engine claims task, compiles bounded instruction with repo constraints and safety guidelines, invokes Codex driver, translates events (`thread.started`, `message.completed`, `completed`), deduplicates receipts via SHA-256, verifies process group stop (`process_group_empty`), finalizes backend run to `done`. | **PASSED** |
| **Claude Driver & Session Resume** | PR-02, §6: End-to-end execution of Claude driver with session pinning and cross-process resume. | Engine claims task, starts Claude run with session ID (`--session-id`), streams events, verifies process stop (`process_group_empty`); follow-up turn resumes with `--resume <session-id>`, proving cross-process continuity without persistent held-open process. | **PASSED** |
| **Missing Terminal Events (T05)** | M4 Gate, T05: Stream drop without terminal event never assumed as success. | Adapter drops stream mid-turn; engine inspects process state; missing/unreachable runs reconciled to `uncertain`, quarantining lock; run never reported as `done`. | **PASSED** |

---

## 3. Verified vs Unverified Platform/Provider Matrix

As required by `TASKS.md` T25, unverified combinations are explicitly recorded below:

### Operating Systems

| OS / Architecture | Status | Verified Capabilities | Deferred / Unverified Aspects |
|---|---|---|---|
| **macOS (Darwin arm64/x64)** | **Verified (M0–M4)** | - Process group detachment (`detached: true`, `pgid == pid`)<br>- Group kill (`process.kill(-pgid, 'SIGTERM')` escalated to `SIGKILL`)<br>- Process liveness identity via `ps -o lstart=,comm=`<br>- APFS case-folding and symlink canonicalization<br>- Loopback Host/Origin guards & tokens<br>- Full M1-M4 test suites | None on macOS. |
| **Linux (x86_64 / arm64)** | **Deferred to T31 (M6)** | Architecture abstractions designed; no Linux-specific system calls tested. | - `PR_SET_PDEATHSIG` sub-reaper tracking<br>- Linux cgroups v2 resource cleanup<br>- `/proc/<pid>/stat` process start-time verification |
| **Windows (x64)** | **Deferred to T31 (M6)** | Architecture abstractions designed; no Windows APIs executed. | - Win32 `JobObjects` process-tree cleanup (`AssignProcessToJobObject`)<br>- `GetProcessTimes` liveness fingerprinting<br>- NTFS/FAT case folding & path canonicalization |

### Providers & Protocols

| Provider | Status | Verified Capabilities | Deferred / Unverified Aspects |
|---|---|---|---|
| **Codex CLI (0.163.0)** | **Verified (M0–M4)** | - `codex exec --json` with `--approve-for-me`<br>- Ephemeral run-scoped MCP config via `-c` flags<br>- Stream mapping to TaskAside event envelope<br>- Process group kill with verified stop proof<br>- Rejection of interactive input / session resume with typed errors | - Codex App Server protocol / approval event schemas (deferred due to `[experimental]` upstream tag). |
| **Claude CLI (2.1.267)** | **Verified (M0–M4)** | - `claude -p` with `--output-format stream-json`<br>- `--permission-mode acceptEdits`<br>- Temporary run-scoped `--mcp-config` with `--strict-mcp-config`<br>- Result event mapping with `is_error` and `terminal_reason`<br>- Cross-process session resume via `--resume <sessionId>`<br>- Process group kill with verified stop proof | - True mid-turn in-process persistent pause (Claude CLI print mode is per-turn; stop-and-resume model verified and fully functional). |

---

## 4. Test Suite Summary

- **Total Engine Checks:** 53/53 passed (`src/execution-engine/engine-checks.ts`).
- **All Repo Checks:**
  - `test:contracts`: 30/30 passed
  - `test:services`: 19/19 passed
  - `test:harness`: 11/11 passed
  - `test:db`: 13/13 passed
  - `test:api`: 27/27 passed
  - `test:runs`: 21/21 passed
  - `test:events`: 13/13 passed
  - `test:mcp`: 6/6 passed
  - `test:projection`: 25/25 passed
  - `test:adapter`: 14/14 passed
  - `test:codex`: 8/8 passed
  - `test:claude`: 12/12 passed
  - `test:safety`: 11/11 passed
  - `test:engine`: 53/53 passed
  - `build`: Vite build output clean (309ms).
  - `typecheck` / `lint`: 0 errors across 93 files.
