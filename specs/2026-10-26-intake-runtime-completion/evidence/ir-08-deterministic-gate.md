# IR-08 Evidence: Deterministic Integration Gate

## 1. Summary of Execution
- Executed `bun run test:startup` three consecutive times from fresh temporary data and real service processes.
- Executed `bun run test:pool` across all 14 worker-pool acceptance checks (P1–P14).
- Executed the full deterministic test suite (`bun run check:deterministic`), spanning 18 distinct suites.

## 2. Test Results

### A. Consecutive Startup Checks (`bun run test:startup` x3)
- Run 1: **PASS** (5/5 checks)
- Run 2: **PASS** (5/5 checks)
- Run 3: **PASS** (5/5 checks)
  - `A1: task enqueued through MCP after real startup reaches done automatically`
  - `A3: independent checkout (repo B) progresses automatically too`
  - `A11: planner-scoped MCP token can enqueue but cannot reach managed-only tools`
  - `A9: engine restart reconciles persisted runs without starting a second writer`
  - `A10: cancelling a live (processing) task waits for verified stop before releasing the lock`

### B. Worker Pool Acceptance Suite (`bun run test:pool`)
- 14/14 checks passed (100%):
  - P1: Automatic dispatch & cadence: **PASS**
  - P2: 8-slot concurrency cap & 9th task waiting: **PASS**
  - P3: Canonical alias serialization: **PASS**
  - P4: Multi-engine contention & CAPACITY_EXCEEDED: **PASS**
  - P5: Non-stalling candidate admission on busy tree: **PASS**
  - P6: Concurrency isolation & HITL reservation: **PASS**
  - P7: Crash & lost ACK idempotent receipts: **PASS**
  - P8: 60-min deadline persistence: **PASS**
  - P9: Unverified stop quarantine: **PASS**
  - P10: Fencing & STALE_GENERATION rejection: **PASS**
  - P11: Graceful shutdown: **PASS**
  - P12: Backend backoff & bounded queries: **PASS**
  - P13: Upgrade compatibility & deadline backfill: **PASS**
  - P14: Installed Codex and Claude live execution: **PASS**

### C. Full Deterministic Suite (`bun run check:deterministic`)
| Test Suite | Path | Result |
|---|---|---|
| `test:contracts` | `src/contracts/contract-checks.ts` | **PASS (39/39)** |
| `test:db` | `src/backend/db-checks.ts` | **PASS (13/13)** |
| `test:api` | `src/backend/api-checks.ts` | **PASS (27/27)** |
| `test:runs` | `src/backend/run-checks.ts` | **PASS (21/21)** |
| `test:events` | `src/backend/event-checks.ts` | **PASS (13/13)** |
| `test:mcp` | `src/backend/mcp-checks.ts` | **PASS (7/7)** |
| `test:projection` | `src/backend/projection-checks.ts` | **PASS (26/26)** |
| `test:services` | `src/supervisor/service-checks.ts` | **PASS (19/19)** |
| `test:supervisor` | `src/supervisor/supervisor-harden-checks.ts` | **PASS (5/5)** |
| `test:harness` | `src/harness/harness-checks.ts` | **PASS (11/11)** |
| `test:adapter` | `src/agent-adapter/adapter-checks.ts` | **PASS (14/14)** |
| `test:safety` | `src/agent-adapter/safety-checks.ts` | **PASS (11/11)** |
| `test:engine` | `src/execution-engine/engine-checks.ts` | **PASS (53/53)** |
| `test:startup` | `src/execution-engine/startup-checks.ts` | **PASS (5/5)** |
| `test:pool` | `src/execution-engine/pool-checks.ts` | **PASS (14/14)** |
| `test:ui` | `src/frontend/ui-checks.ts` | **PASS** |
| `test:workflow` | `src/frontend/workflow-checks.ts` | **PASS (10/10)** |
| `test:distribution` | `src/distribution/distribution-checks.ts` | **PASS (8/8)** |

## 3. Result
- Status: **PASS**
- All 18 deterministic test suites pass without error.
