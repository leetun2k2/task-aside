# Complete the Intake runtime

## TL;DR

- **Goal:** Finish Message-first execution with reliable startup, recovery, and enforced multi-repo writes.
- **Key decision:** Replace implicit runtime rules with versioned run contracts and backend-owned reservations. Large changes are allowed where these guarantees require them.
- **Impact:** Backend task/chat/MCP, engine, adapter drivers, supervisor, shared contracts, and package verification.

```mermaid
flowchart LR
    B[Record baseline] --> C[Define run contracts]
    C --> R[Repair admission and recovery]
    R --> P[Enforce provider scope]
    P --> D[Verify delegation]
    D --> V[Prove supported release]
```

**Authorization:** The user requested an implementation plan on 2026-10-26 and accepts major changes. This permits necessary internal protocol/schema changes; service ownership and product scope remain binding. This planning change does not run agents or change application code.

Read the [delivery slices](01-delivery-plan.md) for execution order and the [acceptance gates](02-acceptance.md) for completion evidence. Existing [Message-first contracts](../2026-10-25-message-intake/01-contracts-and-lifecycle.md) remain the behavioral target. This plan covers MI-01 and MI-04–MI-07 plus MI-02/MI-03 regressions; it does not restart the layered refactor.

## Scope

### In scope

| Item | Readiness | Required outcome |
|---|---|---|
| Startup and pool failures | **Ready** | Reproduce A1/A3 and P1/P3/P11; distinguish fixture faults from runtime defects and prove cold-start execution. |
| Versioned run contracts and migration | **Ready** | Explicit purpose, durable deadline, run fence, repo lock set, execution profile, and recoverable final result. |
| Admission and recovery | **Ready** | Direct/bulk claims share atomic rules; retries and restarts preserve one attempt and its reservations. |
| Intake and delegation | **Ready** | Strict result acceptance, stale-input rejection, fenced handoff, correct HITL, and bounded shared conversations. |
| Multi-repo execution | **Ready** | Every resolved root is locked and dispatched, or execution is visibly blocked before a writer starts. |
| Provider probes and capability gating | **Ready** | Record version/OS-specific evidence; binary discovery alone never enables a route. |
| Live provider/OS enablement | **Blocker** | Intake tool restrictions, allowed write roots, MCP, structured results, and process-tree stop need live evidence for each enabled configuration. Static work may proceed. |
| Upgrade and package verification | **Ready** | Preserve legacy state and prove the installed package matches source behavior. |

### Out of scope

- Stack migration, process consolidation, generic orchestration, factories, or unrelated refactoring.
- New pages, statuses, providers, automatic semantic retries, or provider fallback.
- Unit tests, screenshots, commits, pushes, publishing, and user credential/configuration changes.

## Contract changes

- **Internal protocol v2:** Coordinated backend/engine/adapter cutover. Reject mixed versions before admission; public Message-first REST/MCP remain compatible.
- **Admission/start:** Carry explicit purpose, persisted provider/deadline, input and policy identity, independent run ownership fence, and the complete canonical repo lock set. Intake has an empty set.
- **Adapter outcome:** Expose one bounded final result and process-stop evidence independently of transient SSE. Backend persists accepted result identity; strict output validation remains mandatory.
- **Capabilities:** Separate discovery from proven Intake, MCP, write-root, cancellation, and resume support by provider version and OS.

## Review decisions

| Decision | Reason / consequence |
|---|---|
| Accept breaking internal changes together | A single lock generation cannot represent run ownership plus several repo fences. Old service binaries must stop before migration. |
| Keep SQLite and the three service owners | Larger changes repair current boundaries without adding another coordinator or store. |
| Separate final results from chat/SSE | A restart or buffer loss must not infer completion from the last visible message. No durable token replay is promised. |
| Enforce exact registered write roots | Primary-cwd-only dispatch, broad ancestor permissions, and prompt-only scope do not meet MI-05. |
| Preserve legacy lifecycle semantics | Existing waiting parents and active runs cannot safely be reinterpreted as new terminal delegation. |

## Required behavior

- **Admission:** Intake consumes one global slot and no repo lock. Implementation acquires every required lock and one slot, or nothing. Running, retained HITL, and uncertain attempts count toward the configured cap, at most eight.
- **Completion:** Only a valid current result plus verified process-tree stop can resolve Intake or activate children. Identical retries return the original result; conflicting payloads fail.
- **Recovery:** Persisted purpose, provider, deadline, and fences survive reconnect/restart. Missing stop evidence retains reservations; no successor starts from a timeout or lost adapter record alone.
- **Scope:** Intake has only managed `create_task`/`get_task`, no shell/write tools or ambient MCP. Unsupported profiles fail before spawn. Implementation receives all and only its allowed repo write roots.
- **Handoff:** Parent stays terminal after delegation. Verification has a distinct task ID, shared authorized conversation, and no reservation until all prerequisites are terminal.

## Impact and rollout

Forward migration must preserve messages, receipts, run identities, and per-path generations. Reconcile or safely stop existing runs before coordinated cutover. Never invent stop proof to migrate an active writer. Binary rollback requires a stopped-instance backup restore.

Implementation starts with IR-01. Each slice records evidence; none is marked complete from Claude's summary alone. Known source observations and reported checks are separated in the delivery plan.
