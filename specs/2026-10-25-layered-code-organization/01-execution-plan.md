# Layer refactor: execution tracker

## TL;DR

- **Goal:** Deliver the whole-repository layer refactor as 47 bounded tasks.
- **Key decision:** Work serially; retain current contracts and ownership.
- **Impact:** All application owners, infrastructure, packaging, and checks.

**Status:** In progress. **Next extraction:** LC-05c. LC-01a–LC-05b are recorded done below; LC-05c-p (inserted prerequisite from specs/2026-10-28-layered-refactor-continuation/, not in the table below) is done — see specs/2026-10-25-layered-code-organization/evidence/lc-05c-p.md. Planning is not implementation evidence.

**2026-10-28 continuation:** Read the [current audit and ordered plan](../2026-10-28-layered-refactor-continuation/00-overview.md), [lifecycle cards](../2026-10-28-layered-refactor-continuation/01-lifecycle-cards.md), and [remaining owner cards](../2026-10-28-layered-refactor-continuation/02-owner-cards.md). First continuation action: LC-00p scope/baseline alignment, then the named safety prerequisites for affected lifecycle extractions. Existing completed cards stay done. This is a proposal, not new runtime evidence. Darwin arm64 is the sole release target; LC-12d/e are dropped by the current user request.

Read the [main plan](../2026-10-25-layered-code-organization.md), [task cards](02-task-cards.md), and [Antigravity prompt](03-antigravity-prompt.md). Parent IDs LC-01–LC-12 refer to the main plan; lettered IDs below are executable slices. This tracker controls only this follow-up; do not restart RF-01–RF-57 or copy their claimed results.

## Delivery order

```mermaid
flowchart LR
    B[Baseline] --> S[Backend]
    S --> U[Frontend]
    U --> E[Engine]
    E --> A[Adapter]
    A --> C[CLI and packaging]
    C --> V[Local verification]
    V --> G[Provider and OS gates]
```

## Scope

### In scope

**Ready:** The retained tasks are selected within the confirmed whole-repo scope. The table preserves the original 47 IDs, including two dropped OS gates. Execution depends on listed prerequisites plus the continuation's safety slices. Live-provider/Darwin evidence requires actual access; classify missing access when attempting those gates.

### Out of scope

New features, API/schema changes, dependency upgrades, generic frameworks, unit-test authoring, screenshots/videos, Git commits/pushes, external publication, and edits to user work repos.

## Execution rules

- **One task at a time:** Choose the first unfinished retained task whose technical prerequisites are `done`. Mark it `doing`, inspect its current callers, implement, verify, record evidence, then mark `done`. Resume from the continuation; do not restart LC-01a–LC-05a.
- **Small slices:** A card is an outcome, not permission to rewrite its whole owner. Split an oversized card into child IDs and update dependencies before editing. Preserve incomplete migration bridges until their callers move.
- **All callers:** Move a complete action across REST/internal/MCP callers together when atomicity or authorization requires it. Do not leave nested callers publishing before outer commit.
- **Safe checks:** Use disposable repos, DBs, data dirs, ports, and fake providers. Inspect setup/cleanup first. Do not use the live TaskAside installation. Existing suites may be run; add only missing contract/integration/process/browser-interaction checks, never new unit tests or screenshot capture.
- **Common checks:** For each code slice, run `bun run typecheck`, `bun run lint`, and the matching owner build plus the card's relevant suites. Use `bun run <script>` for the script names in cards. Run full `bun run check` at final local acceptance.
- **Shared helpers:** LC-11a consolidates shared infrastructure. Extract a concrete helper earlier with all consumers if needed to keep an earlier slice safe; document the change and avoid repeating completed work.
- **Baseline defects:** Preserve exact failing evidence. A safety defect blocks affected work until repaired within a named scoped slice; never weaken checks or treat baseline failure as success.
- **Environment gates:** LC-12c depends on LC-12b. Record unavailable required provider/Darwin evidence as `blocked` with a reason. LC-12d/e are dropped, not blocked or passed. LC-12f reports the remaining required gates; the refactor remains partial while they are blocked.
- **No implicit approval loop:** Whole-repo scope and simple-read bypass are confirmed. Use judgment for reversible internal choices. Ask only for a material new decision or required missing access; do not ask to reapprove each card.

## Task tracker

Allowed statuses: `todo`, `doing`, `done`, `blocked`, `dropped`. `dropped` records an explicit scope removal, never a pass. Keep the next-task note above current.

| ID                                | Task                                                | Owner                      | Dependencies                           | Status |
| --------------------------------- | --------------------------------------------------- | -------------------------- | -------------------------------------- | ------ |
| [LC-01a](02-task-cards.md#lc-01a) | Inventory commands and safe environments            | all / baseline             | None                                   | done   |
| [LC-01b](02-task-cards.md#lc-01b) | Record backend contract baseline                    | all / baseline             | LC-01a                                 | done   |
| [LC-01c](02-task-cards.md#lc-01c) | Record UI and lifecycle baseline                    | all / baseline             | LC-01b                                 | done   |
| [LC-02a](02-task-cards.md#lc-02a) | Pilot settings layers                               | backend                    | LC-01c                                 | done   |
| [LC-02b](02-task-cards.md#lc-02b) | Separate Git repository registration                | backend                    | LC-02a                                 | done   |
| [LC-03a](02-task-cards.md#lc-03a) | Separate task and context reads                     | backend                    | LC-02b                                 | done   |
| [LC-03b](02-task-cards.md#lc-03b) | Extract task creation                               | backend                    | LC-03a                                 | done   |
| [LC-03c](02-task-cards.md#lc-03c) | Extract task editing                                | backend                    | LC-03b                                 | done   |
| [LC-03d](02-task-cards.md#lc-03d) | Unify cancel and retry entry actions                | backend                    | LC-03c                                 | done   |
| [LC-04a](02-task-cards.md#lc-04a) | Separate ordinary chat reads and writes             | backend                    | LC-03d                                 | done   |
| [LC-04b](02-task-cards.md#lc-04b) | Extract HITL reply transaction                      | backend                    | LC-04a                                 | done   |
| [LC-04c](02-task-cards.md#lc-04c) | Unify input-required application action             | backend                    | LC-04b                                 | done   |
| [LC-04d](02-task-cards.md#lc-04d) | Separate event ingestion and publication            | backend                    | LC-04c                                 | done   |
| [LC-05a](02-task-cards.md#lc-05a) | Extract atomic admission and claims                 | backend                    | LC-04d                                 | done   |
| [LC-05b](02-task-cards.md#lc-05b) | Extract heartbeat ownership action                  | backend                    | LC-05a                                 | done   |
| [LC-05c](02-task-cards.md#lc-05c) | Extract verified finalization                       | backend                    | LC-05b                                 | todo   |
| [LC-05d](02-task-cards.md#lc-05d) | Separate yield intent and parent readiness          | backend                    | LC-05c                                 | todo   |
| [LC-05e](02-task-cards.md#lc-05e) | Extract uncertain-run and quarantine actions        | backend                    | LC-05d                                 | todo   |
| [LC-06a](02-task-cards.md#lc-06a) | Separate credentials and pairing                    | backend                    | LC-05e                                 | todo   |
| [LC-06b](02-task-cards.md#lc-06b) | Extract scoped task creation for agents             | backend                    | LC-06a                                 | todo   |
| [LC-06c](02-task-cards.md#lc-06c) | Thin remaining MCP dispatch                         | backend                    | LC-06b                                 | todo   |
| [LC-07a](02-task-cards.md#lc-07a) | Separate frontend transport and browser storage     | frontend                   | LC-06c                                 | todo   |
| [LC-07b](02-task-cards.md#lc-07b) | Extract frontend task action hooks                  | frontend                   | LC-07a                                 | todo   |
| [LC-07c](02-task-cards.md#lc-07c) | Extract conversation action and query hooks         | frontend                   | LC-07b                                 | todo   |
| [LC-07d](02-task-cards.md#lc-07d) | Extract browser SSE and live-state rules            | frontend                   | LC-07c                                 | todo   |
| [LC-07e](02-task-cards.md#lc-07e) | Finish frontend presentation composition            | frontend                   | LC-07d                                 | todo   |
| [LC-08a](02-task-cards.md#lc-08a) | Separate engine clients by target                   | engine                     | LC-07e                                 | todo   |
| [LC-08b](02-task-cards.md#lc-08b) | Separate admission actions and scheduler state      | engine                     | LC-08a                                 | todo   |
| [LC-08c](02-task-cards.md#lc-08c) | Separate dispatch and event delivery actions        | engine                     | LC-08b                                 | todo   |
| [LC-08d](02-task-cards.md#lc-08d) | Separate resume, cancel, timeout and reconciliation | engine                     | LC-08c                                 | todo   |
| [LC-08e](02-task-cards.md#lc-08e) | Thin runtime and engine entrypoint                  | engine                     | LC-08d                                 | todo   |
| [LC-09a](02-task-cards.md#lc-09a) | Separate adapter run registry and log I/O           | adapter                    | LC-08e                                 | todo   |
| [LC-09b](02-task-cards.md#lc-09b) | Extract adapter start and inspect actions           | adapter                    | LC-09a                                 | todo   |
| [LC-09c](02-task-cards.md#lc-09c) | Extract adapter input and stop actions              | adapter                    | LC-09b                                 | todo   |
| [LC-09d](02-task-cards.md#lc-09d) | Separate adapter streams and callbacks              | adapter                    | LC-09c                                 | todo   |
| [LC-10a](02-task-cards.md#lc-10a) | Separate CLI parsing and rendering                  | CLI / supervisor           | LC-09d                                 | todo   |
| [LC-10b](02-task-cards.md#lc-10b) | Separate supervisor storage and process I/O         | CLI / supervisor           | LC-10a                                 | todo   |
| [LC-10c](02-task-cards.md#lc-10c) | Extract supervisor lifecycle actions                | CLI / supervisor           | LC-10b                                 | todo   |
| [LC-11a](02-task-cards.md#lc-11a) | Consolidate concrete shared infrastructure          | infrastructure / packaging | LC-10c                                 | todo   |
| [LC-11b](02-task-cards.md#lc-11b) | Finish Node launcher and installed payload          | infrastructure / packaging | LC-11a                                 | todo   |
| [LC-11c](02-task-cards.md#lc-11c) | Align check support and build wiring                | infrastructure / packaging | LC-11b                                 | todo   |
| [LC-12a](02-task-cards.md#lc-12a) | Remove bridges and enforce layer boundaries         | all / acceptance           | LC-11c                                 | todo   |
| [LC-12b](02-task-cards.md#lc-12b) | Run final local regression                          | all / acceptance           | LC-12a                                 | todo   |
| [LC-12c](02-task-cards.md#lc-12c) | Verify current Codex and Claude paths               | all / acceptance           | LC-12b + required environment          | todo   |
| [LC-12d](02-task-cards.md#lc-12d) | Native Linux gate dropped (Darwin arm64 scope)      | all / acceptance           | None — explicit scope removal         | dropped |
| [LC-12e](02-task-cards.md#lc-12e) | Native Windows gate dropped (Darwin arm64 scope)    | all / acceptance           | None — explicit scope removal         | dropped |
| [LC-12f](02-task-cards.md#lc-12f) | Publish local handoff completion report             | all / acceptance           | LC-12b + recorded outcome for LC-12c   | todo   |

## Evidence and resumption

Create `evidence/<task-id>.md` here only while doing the task. Record: outcome; affected owners/files; exact command, runtime, and result; passed and failed assertions; known baseline defects; environment limits; rollback; next task. Never include credentials or fabricate results.

Mark `done` only with current acceptance evidence. A skipped/unavailable browser, provider, or OS check is not a pass. If a task is blocked, name the dependency/access needed and the next safe task. Do not edit previous evidence to make it appear current.

Rollback means reverting only the task's patch or, if separately authorized and created, its commit. No migration is planned. Never reset/clean the checkout or overwrite existing user work.

**Handoff validation:** Document checks only in this planning session. Application suites have not been run for this handoff.
