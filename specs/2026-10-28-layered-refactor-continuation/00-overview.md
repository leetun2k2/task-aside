# Continue the layer refactor from LC-05b

## TL;DR

- **Goal:** Finish the layer refactor without losing Intake or multi-repo execution.
- **Key decision:** Keep the existing card IDs; repair proven safety gaps in separate slices before extracting affected flows.
- **Impact:** Backend lifecycle first, then access, frontend, engine, adapter, CLI, infrastructure, and acceptance.

```mermaid
flowchart LR
    B[Lifecycle and safety] --> M[MCP access]
    M --> U[Frontend]
    U --> E[Engine]
    E --> A[Adapter]
    A --> C[CLI and package]
    C --> V[Darwin verification]
```

**Status: proposal, 2026-10-28.** LC-01a–LC-05a remain done according to the existing tracker and evidence. Next extraction: **LC-05b**. No application code changes are included here.

Read the [lifecycle audit and cards](01-lifecycle-cards.md), then the [remaining owner cards](02-owner-cards.md). These supplement the [original tracker](../2026-10-25-layered-code-organization/01-execution-plan.md) and supersede stale scope, file targets, and acceptance notes for unfinished cards.

## Scope

### In scope

| Item                                   | Readiness                      | Outcome                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing LC-05b–LC-12f actions         | **Ready**                      | Smaller modules retain current wire shapes, errors, state ownership, and entrypoints. Safety prerequisites below gate affected actions.                                                   |
| Darwin arm64 support                   | **Ready**                      | Linux, Windows, and macOS x64 release gates are dropped by the current user request. Retain old IDs for history.                                                                          |
| Missing regression coverage            | **Ready**                      | Extend existing contract, integration, process, and DOM interaction suites. No new unit tests or screenshots.                                                                             |
| Durable scope and launch-proof repairs | **Assumption — review**        | Use small explicit safety slices from the approved MR plan. They require a coordinated internal-contract/schema review before code changes; they are not hidden inside file moves.        |
| Provider filesystem enforcement        | **Blocker for release claims** | Current MR evidence lacks live two-root edits plus outside-root tool/shell denials and descendant-stop results for each provider. It does not block planning or safe internal extraction. |

### Out of scope

New product features, providers, states, routes, scheduling policy, database engines, frameworks, automatic cross-repo rollback, commits, pushes, publication, or work in registered user repos. No full refactor implementation in this session.

## Review decisions

| Decision                                          | Reason                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve LC numbering                             | LC-06 is MCP/access; LC-07 frontend; LC-08 engine; LC-09 adapter. Renumbering would break evidence and dependencies.                                                               |
| Separate repairs from moves                       | Passing current suites does not establish complete scope fencing or trustworthy stop proof. Record changed behavior and checks explicitly.                                         |
| Keep current Intake integration during extraction | Current delegation uses scoped MCP to create staged children. The MR plan's “tool-free” wording cannot silently remove that contract. A routing redesign is outside this refactor. |
| Retain ordinary domain usecases and explicit I/O  | No generic repository, factory, callback framework, or generic transaction manager. Simple reads may call repositories directly.                                                   |

## Required invariants

- **Atomic ownership:** An implementation claim validates and locks every canonical root, creates one run and receipt, and occupies one slot in one synchronous immediate SQLite transaction. Any failure rolls back the whole scope.
- **Complete fencing:** Validate run identity, owner, and run fence separately from each tree's generation. Different trees may have different generations. Load the expected set from durable backend state; a caller cannot select a subset.
- **Lease and stop:** Expiry, a signal, a top-level exit, or missing adapter state never releases a root. Uncertainty retains the full lock set and one global slot. Finalization releases all owned roots only after trusted stop evidence for the current launch.
- **Intake:** No repo lock, one shared slot, original deadline/revision, structured result acceptance, and task-level input pairing. `implement` resolves every repo; `delegate` completes the parent; implementation HITL retains all locks.
- **Boundaries:** Only backend imports SQLite/database modules. Task owns runs and locks; Chat owns messages. Cross-domain usecases coordinate repositories. Engine uses HTTP; adapter owns spawn/termination; frontend uses one Query cache.
- **Commit before notification:** Outermost commit precedes browser publication, including nested admission, Intake delegation, and parent readiness. Rollback publishes nothing. Preserve event hashes, ACK retries, versions, and snapshot recovery.

## Ordered delivery

1. **LC-00p:** Reconcile current scope and record the safety backlog. Run fresh isolated baseline checks; keep prior evidence unchanged.
2. **LC-05a-r1/r2:** Persist complete scope/fences, repair replay and full-set validation, and repair outer-commit publication. These are prerequisites for claiming lifecycle safety.
3. **LC-05b:** Extract heartbeat. **LC-05c-p:** repair stop evidence before accepting verified finalization as safe. Then extract **LC-05c**, **LC-05d**, **LC-05e**, and its small **LC-05e-q** query/marker follow-up. LC-05c-p brings forward necessary parts of LC-09c; do not repeat them later.
4. **LC-06a–c → LC-07a–e → LC-08a–e → LC-09a–d → LC-10a–c → LC-11a–c.** Run each action's checks before the next slice. Fix scope/deadline handoff before LC-08 dispatch extraction; do not migrate an incomplete payload.
5. **LC-12a–c → LC-12f.** LC-12d/e are dropped, not passed. Darwin live provider and installed-payload proof remain required.

One reviewable action per slice. No task is done from planning alone. Keep existing forwarding bridges until every real caller has moved. No source-tree cleanup or reset: this checkout already contains substantial staged and unstaged user work.

## Verification recorded in this planning session

| Command                  | Fresh result | Limit                                                                             |
| ------------------------ | ------------ | --------------------------------------------------------------------------------- |
| `bun run test:runs`      | 21/21 pass   | Existing baseline; mainly single-tree ownership and admin recovery.               |
| `bun run test:contracts` | 39/39 pass   | Existing schemas/scanner; not full layer enforcement or multi-root runtime proof. |

The MR evidence reports **18/18 deterministic suites**, including **58/58 engine** and **14/14 pool** checks. Those are prior results, not rerun here. No live provider, browser, process, full deterministic, or installed-payload suite was run for this proposal. Source findings in the audit are not claimed as reproduced failures.

## Advanced: documentation deltas for LC-00p

- `AGENTS.md`, `specs/CONSTITUTION.md` §VIII, `specs/ARCHITECTURE.md` §§4–6/8/10, and `specs/2026-10-18-initialize-project/SPECIFICATION.md` still contain cross-OS, single-root, and older Intake language. Add a dated scope amendment using the current user request; retain historical evidence. Constitution enforcement references to unit tests/screenshots yield to the current explicit instructions.
- `specs/2026-10-25-layered-code-organization.md` and the R4 overview still say implementation has not started. The tracker table and LC-05a evidence show otherwise. The tracker next-task note is corrected in this planning patch.
- `specs/2026-10-26-intake-runtime-completion/03-multirepo-plan.md` describes a target stronger than the MR evidence/code: independent run fences, immutable per-tree generations, launch-bound stop receipts, and provider denial proof. Treat those as remaining safety work, not already delivered guarantees.
- `evidence/ir-09-release-matrix.md` says multi-repo dispatch is blocked; current capabilities advertise it from executable presence plus Darwin arm64, and manager permits Codex/Claude by provider name. Reconcile the capability matrix against actual proof; do not infer MR-08 completion from the evidence filename.
- `App.tsx`/`AppShell.tsx` already route to settings pages, while AGENTS lists three routes and settings as a modal. Record this separate UI scope mismatch before LC-07e; no page removal/addition is bundled into this refactor.
