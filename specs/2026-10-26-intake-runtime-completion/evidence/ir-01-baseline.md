# IR-01: Baseline and Capability Inventory

## Overview
- **Slice:** IR-01
- **Status:** PASS
- **Execution Date:** 2026-10-26
- **Commit Baseline:** 1f3598e25a4f2c20317c5fb2a477353a4f04eb90

## Installed Provider Inventory
- `codex-cli`: `0.164.0` (Darwin arm64)
- `claude`: `2.1.267 (Claude Code)` (Darwin arm64)
- `agy`: `/Users/tungle/.local/bin/agy` (Antigravity CLI)

## Startup & Pool Suite Investigation (A1/A3, P1/P2/P3/P11)

### 1. Initial Failure Reproduction
Initial execution of `bun run test:startup` failed:
- `A1: task enqueued through MCP after real startup reaches done automatically: expected task to reach done, got error: Intake did not return one valid final JSON result matching the schema`
- `A3: independent checkout (repo B) progresses automatically too: expected repo B task to reach done, got error`

Initial execution of `bun run test:pool` failed:
- `P1`: waitFor timed out after 15000ms
- `P2`: waitFor timed out after 20000ms
- `P3`: waitFor timed out after 15000ms
- `P11`: waitFor timed out after 15000ms

### 2. Root Cause Analysis: Stale Bundles vs. Production Defect
Investigation of service execution showed:
- `src/supervisor/process-manager.ts` lines 146-150:
  ```ts
  const bundledEntry = join(repoRoot, 'dist', 'services', `${name}.js`);
  const sourceEntry = join(repoRoot, SERVICE_ENTRYPOINT[name]);
  const entrypoint = existsSync(bundledEntry) ? bundledEntry : sourceEntry;
  ```
- `dist/services/agent-adapter.js` had a build timestamp of `Oct 26 08:15` (prior to message intake implementation). It did not contain `synthesizeFakeIntakeResultContent` and returned raw `"Working on it, done."` on `message.completed`, causing Intake JSON parsing to fail immediately and mark the task `error`.
- Because `dist/services/` existed, `startServices()` launched the stale compiled JavaScript bundle instead of the current TypeScript source code in `src/`.
- Rebuilding `dist/services` with `bun run build:services` and re-running produced:
  - `test:startup`: **5/5 passed** (A1, A3, A11, A9, A10).
  - `test:pool`: **14/14 passed** (P1–P14).

### 3. Key Finding for IR-01
The failures A1, A3, P1, P2, P3, P11 in the unmodified worktree were caused by `process-manager.ts` preferring stale `dist/services/*.js` over fresh `src/` source files.
Fix required in supervisor/process-manager: When source entry exists (development workspace), prefer source entry unless `TASKASIDE_USE_DIST` is explicitly set or packaged in distribution where `src/` is absent.

## Identified Runtime Gaps for IR-02–IR-07
1. **Run contracts (`src/contracts/run.ts`)**: `StartRunRequest` lacks explicit `purpose: 'intake' | 'implementation'`, `writeRoots: string[]`, `runFence: number`, and separate lock generations.
2. **Adapter Manager (`src/agent-adapter/manager.ts`)**: Intake fake scenario relies on cwd substring `intake-scratch` rather than explicit run contract purpose.
3. **Dispatcher & Reconciler (`src/execution-engine/dispatcher.ts`, `reconciler.ts`)**: Intake outcome is extracted from the last forwarded message rather than a durable adapter terminal outcome receipt. Reconciler finalizes without purpose branch.
4. **Admission & Claim Transactions (`src/backend/domains/task/usecases/`)**: `claimTaskUsecase` only claims one repo; does not atomically claim multi-repo lock sets. `admitNextTaskUsecase` and `claimIntakeUsecase` perform capacity reads outside the write transaction.
5. **Provider Drivers (`src/agent-adapter/drivers/`)**: Drivers lack strict profile enforcement for Intake (no write tools, managed MCP only) and multi-root write permissions.
