# Reliable handoff and a single TaskAside writer

## TL;DR
- **Goal:** Hand off approved work through MCP and execute without overlapping writers.
- **Key decision:** A yield request is intent, never proof of process exit. Keep the lock until trusted process verification succeeds.
- **Impact:** MCP clients, backend run state, engine lifecycle, adapter stop evidence, and readiness claims.

## Planning sessions hand off to one execution authority

```mermaid
flowchart LR
    P[Read-only planning sessions] --> Q[MCP backlog]
    Q --> E[Engine selects eligible work]
    E --> L[Backend grants checkout lock]
    L --> W[One managed writer]
```

## Contract changes

| Contract | Delta / compatibility |
|---|---|
| MCP `create_task` | External callers must supply `repoId` and `idempotencyKey`. Reject missing fields; never select a default repo. Existing clients must change. |
| Managed task creation | Inherit the parent's repo; reject an explicitly different repo. Require an idempotency key for retry safety. Existing depth/count limits remain. |
| MCP `yield_task` | Return `status: yield_requested` after durable acceptance, not `yielded`. Repeating the same pending intent has no extra effect. No client field/header can attest process exit. |
| Internal yield completion | Authenticated, owner/fenced completion requires trusted adapter stop evidence for the exact run. Only then may the backend release the lock and block the parent on children. |

## Scope

### In scope

| Item | Readiness | Outcome / basis |
|---|---|---|
| Automatic execution | **Ready** | Service startup schedules, dispatches, heartbeats, and reconciles automatically. |
| Safe yield and recovery | **Ready** | No overlapping writers during yield, cancellation, restart, or uncertain process state. |
| Correct MCP handoff | **Ready** | Explicit repo selection, scope checks, durable deduplication, and validation. |
| Planner workflow and honest status | **Ready** | Document read-only planner setup and report only verified capabilities. |
| One local authority per checkout | **Assumption — review** | Retain local-first deployment. Please review: multiple authorities need shared ownership coordination. |
| Exclusivity across machines or arbitrary external processes | **Blocker** | Requires deployment and filesystem-isolation decisions. MCP cannot remove external write access. Local repairs may proceed independently. |

### Out of scope

- Remote hosting, shared distributed locks, repo-wide locking across separate clones/worktrees, new execution providers, and UI redesign.
- Publishing, license selection, and untested Linux/Windows support. Agy can be an MCP planner without an execution driver.

## Review decisions

| Decision | Why |
|---|---|
| Keep canonical working-tree lock identity | Matches current persistence and alias handling; does not imply global repo exclusivity. |
| Make yield asynchronous | Waiting for the caller's exit inside its MCP request can deadlock. |
| Require explicit external repo selection | Choosing the first authorized repo can execute approved work in the wrong checkout. |

## Behavior

- **Live engine:** Picks P0–P3/FIFO among eligible tasks, respects global concurrency, skips busy checkouts, and never preempts running work. Separate runs cannot mix messages, sequence receipts, or stop evidence.
- **Ownership:** Claim/run/lock is atomic. Owner and generation guard every mutation. Lease expiry, missing ACK, and terminal messages alone never permit a second writer.
- **Yield:** Accepted intent survives restart and retains ownership until verified exit. Unknown exit quarantines the checkout. Finalization and concurrent events cannot turn a yielding parent into a completed task or release the lock twice.
- **Children:** After safe yield, children can run on the same checkout. The parent becomes eligible only when all selected children succeed; failed/cancelled children keep a visible block. Preserve existing depth/count limits.
- **Handoff:** Authorized external creation uses the requested registered repo. Identical key/payload retries return the same task across restart; different payload reuse conflicts. Missing/unknown/forbidden targets never create tasks.
- **User actions and restart:** Normal service operation handles cancellation and matched HITL replies. Reconcile persisted runs before new claims; uncertain writers remain blocked. Recovery cannot bypass fencing or duplicate a provider process.
- **Planner boundary:** Planners use read-only harnesses/checkouts and MCP queue permissions. Document that prompts alone cannot enforce filesystem access.

## Impact

- **Services:** Preserve current ownership boundaries, three services, and one npm package.
- **Persistence:** Preserve tasks/chat/locks/generations and pending yield/dedup state. Never clear uncertain locks on upgrade.
- **Readiness:** Correct stale README/backlog claims. Local repairs do not establish full multi-developer exclusivity or release readiness.

## Advanced

### Acceptance evidence required

Use disposable repos/data directories and contract, integration, and process checks. Do not write unit tests or use screenshots. Exercise the actual service entrypoints and HTTP/MCP boundaries; directly invoking scheduler modules is insufficient evidence of automatic execution.

| ID | Scenario | Required evidence |
|---|---|---|
| A1 | Queue work through MCP after normal service startup | Task advances without an external caller manually triggering scheduling or dispatch. |
| A2 | Two tasks target checkout A; one targets B | A's write intervals never overlap; B can progress while A is occupied. Run interleaved output to expose cross-run stream contamination. |
| A3 | A busy checkout has high-priority tasks | Other eligible checkouts still progress; priority/FIFO and configured concurrency hold. |
| A4 | Live parent calls yield with absent/false/true forged stop headers | Intent may be accepted; ownership stays held while the process can write. Client assertions never create trusted stop evidence. |
| A5 | Parent exit, yield replay, stale generation, and terminal events race | One safe release, no stale mutation, no duplicate child execution; parent resumes after child success. Failed/cancelled children keep it blocked. |
| A6 | Stop verification fails or adapter disappears | Checkout remains held/quarantined. New claims fail even after heartbeat expiry. |
| A7 | External token allows repos A and B | Explicit B creates in B; omitted repo is validation failure, unknown repo is not-found, forbidden repo is denied. No task is created on failure. |
| A8 | Creation retry and backend restart | Same principal/key/payload returns one task; changed title/description/priority/repo conflicts. Distinct principals cannot read or overwrite each other's receipt. |
| A9 | Restart engine during claim/start, pending yield, or HITL | Persisted ownership survives. Reconciliation either safely recovers or quarantines; no new writer starts on an uncertain checkout. |
| A10 | Cancel live task; answer HITL through normal API/chat | Verified termination precedes cancellation release. Matched replies continue safely; duplicate/stale replies do not spawn work. Unsupported provider input is explicit. |
| A11 | Planner and execution access | Demonstrate a planner cannot edit a disposable controlled checkout while it can enqueue a task. If the harness cannot enforce read-only access, report this guarantee as unverified. |
| A12 | Real providers | Smoke the repaired startup-to-task-completion path separately for installed Codex and Claude. Preserve raw evidence with secrets removed; separate fake/process evidence from live-provider evidence. |

**Security details:** Scope deduplication to the authenticated principal; compare the normalized effective creation payload and return only authorized existing tasks. Managed tokens expire on finalization. Old tokens/generations cannot complete yields or mutate a successor's lock. Trusted stop evidence must identify the process tree/run, not merely an exit label, a sent signal, or a caller-provided boolean.

**Recovery details:** Persist enough state to discover unfinished runs and pending yield requests after an engine crash. A new engine must not impersonate the old owner. Any owner transfer needs explicit authenticated fencing semantics; otherwise retain/quarantine the old ownership. Do not solve recovery by advancing a generation while an old process can still write.

### Audit baseline: inspected on 2026-10-24

These are findings to reproduce, not implementation instructions. Follow the call chains before editing.

- The production engine entrypoint constructs and exports modules without polling/dispatch/reconciliation: [engine entrypoint](../src/cmd/execution-engine.ts).
- Missing `x-verified-stopped` becomes true, and yield writes stop metadata and releases the lock: [MCP handler](../src/backend/mcp/handler.ts), [MCP tools](../src/backend/mcp/tools.ts).
- External creation does not accept repo selection and picks the first allowed repo: [MCP contracts](../src/contracts/mcp.ts), [MCP tools](../src/backend/mcp/tools.ts).
- A disposable in-memory backend accepted yield with no stop evidence, synthesized verified-stop metadata, and allowed a same-checkout child claim. Another request asked for repo B and created in repo A.
- Existing `typecheck`, `test:runs` (21/21), and `test:mcp` passed during the audit despite these gaps. They do not establish actual service lifecycle correctness.
- Relevant existing contracts: [constitution](CONSTITUTION.md), [architecture](ARCHITECTURE.md), [specification](2026-10-18-initialize-project/SPECIFICATION.md), [plan](2026-10-18-initialize-project/PLAN.MD), [task status](2026-10-18-initialize-project/TASKS.md).

**Completion report:** List each acceptance ID as passed, failed, or unverified with the command/process evidence. Any failed local safety criterion blocks local repair completion. Unverified live providers, planner isolation, other operating systems, and global exclusivity remain explicit gaps; do not rename them as passed or silently narrow the mission.
