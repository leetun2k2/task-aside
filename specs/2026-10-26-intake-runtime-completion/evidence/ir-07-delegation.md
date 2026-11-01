# IR-07 Evidence: Terminal Handoff and Shared Verification

## 1. Summary of Changes
- **Delegation Atomicity (`commit-intake-result-usecase.ts`)**:
  - Handoff from parent to child tasks is strictly atomic inside a single SQLite transaction:
    - Listed staged child tasks (`block_kind = 'staged_by_parent_intake'`) are activated (`block_kind = NULL`).
    - Unlisted staged children created for this parent are automatically cancelled (`status = 'cancelled'`, `blocked_reason = 'Cancelled: omitted from parent delegation'`) so they cannot remain orphaned.
    - Staged verification task is promoted to `prerequisites` wait (`blocked_on_child_ids = uniqueChildIds`).
    - Parent task is marked `done` (terminal completion, not waiting-parent yield).
    - Intake run is finalized with outcome `'delegate'`.
    - Informative agent message is inserted into conversation summarizing delegation.
- **Child Task Creation Constraints (`create-task-usecase.ts`)**:
  - Validates that child candidate repositories do not exceed the parent's authorized repository scope (`FORBIDDEN`).
  - Sets effective `authorizedRepoIds` on child bounded by parent's scope.
  - Enforces that child task conversation matches parent conversation (`FORBIDDEN` if different).
  - Enforces that verification task cannot wait on parent and must only wait on sibling work children.
- **Prerequisite Reconciler (`tasks.ts:reconcileBlockedParents`)**:
  - Promoted verification tasks wait in `todo` status with prerequisite reason until all prerequisite work children are terminal. Reconciler unblocks the verification task once all prerequisites complete.

## 2. Executed Checks
- `bun run test:mcp`: PASS (7/7 checks passed)
  - Proved depth 1 enforcement, child limit ceiling (5 max), duplicate child idempotency dedup.
- `bun run test:engine`: PASS (53/53 checks passed)
  - Proved parent/child delegation, yield lock release, child execution, and automatic parent unblock.
- `bun run test:workflow`: PASS (10/10 checks passed)
  - Proved child tasks, parent links, and blocked alerts in live user workflow.

## 3. Result
- Status: **PASS**
- Delegation is terminal, atomic, and bounded; orphaned staged children are cancelled; verification tasks are prerequisite-gated.
