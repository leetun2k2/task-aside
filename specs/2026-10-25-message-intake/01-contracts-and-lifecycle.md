# Intake contracts and safe lifecycle

## TL;DR

- **Goal:** Make an unresolved task executable without trusting model output as authority.
- **Key decision:** Backend owns durable resolution, caller scope, stage claims and all repository locks.
- **Impact:** Coordinated task/chat, admission, MCP authorization and adapter contract changes.

## Scope

### In scope

| Item | Readiness | Outcome |
|---|---|---|
| Input, output, persistence and stage contracts below | **Ready** | Deterministic validation before agent dispatch. |
| Legacy request window | **Assumption — review** | Accept old callers for one coordinated release; removing that window only changes rollout. |
| Intake capability on each installed CLI | **Blocker — live enablement** | Must prove tool restrictions, scoped MCP and structured result extraction. |
| Multi-repo writer mode | **Blocker — live enablement** | Must prove allowed roots and process-tree stop for each selected provider/OS. |

### Out of scope

- Generic workflow stages, agent-managed locks, implicit permission grants, or multi-repo Git transactions.

## Message is a chat message

The minimum REST or MCP business payload is:

```json
{ "message": "Update the login API and its UI across the registered repos." }
```

Validate nonblank content without changing the supplied Markdown. Propose a 32 KiB UTF-8 limit for Message and align chat ingestion with it; current chat contracts only enforce a minimum length, not a maximum. Store content in chat, with a task reference to the initial message; do not maintain a second mutable Message body on tasks. Always include the initial Message in Intake context, even when older history is truncated. Retain raw-HTML-disabled Markdown rendering.

`title`, `priority`, `repoIds`, and `parentId` are optional. Title/priority are proposed overrides; repos are confirmed hints. Omission means auto-resolve; it must not be confused with explicit P2. `repoIds` contains distinct registered, authorized IDs; reject an empty explicit list or simultaneous `repoId` and `repoIds`. Intake can replace or expand those hints within caller permissions. Parent selection requires authorization, depth and cycle checks.

Use separate submitted title/priority, repo hints and resolved metadata. Until Intake succeeds, show a deterministic short title from the first nonblank Message line, provisional P2 and “Auto” repository/provider. These defaults are not user overrides. Search includes Message; task headers and rows support unresolved and multiple repos. An authorized task may reuse a conversation; it appends its own Message and keeps its own initial-message reference.

Before first admission, task edit can correct its own initial Message atomically with its input revision. After admission, corrections are new task-targeted user messages. Do not add general chat editing or recreate Description. A targeted new instruction before writer admission invalidates that task's resolution at a verified-stop boundary. Other tasks' output in a shared conversation does not invalidate it. Messages during implementation keep the next-safe-turn policy; terminal tasks never reopen implicitly.

## Candidate scope is permission, resolved scope is intent

At creation, persist the caller's authorized repository set. Browser submissions can use the registered catalog available to that user. External MCP submissions inherit the paired token's repo restrictions; managed children inherit a bounded subset of the parent's authorized scope. Never replace a restricted caller's missing repo with all registered repos.

Intake receives only authorized repository metadata: ID, name, canonical path, and available declared description. It does not scan arbitrary folders. Submitted repos guide relevance, not authorization. Only registered, authorized IDs can appear in the accepted result; explain changes from the hints briefly. Before writer admission revalidate registration, paths, grants and title/priority overrides. Revocation or path changes invalidate the result; no permission expansion occurs on restart.

History is bounded to messages already in the task's `conversationId`. Never fetch a parent, child or another task's conversation as extra history. Authorized task identity, delegation links and prerequisite statuses remain structured metadata, not a history lookup. Reusing a conversation requires access to the whole conversation; neither `parentId` nor a known conversation ID grants that access. For external reads/listing, the task scope and shared conversation must both be authorized. Filtering by one matching repo must not disclose another repo's messages. See [shared conversations](04-delegation-and-follow-up.md).

## Intake result is structured data

Example of the final result payload, separate from provider stream envelopes:

```json
{
  "version": 1,
  "action": "implement",
  "title": "Update login API and UI",
  "repoIds": ["repo-api", "repo-web"],
  "priority": "P2",
  "executionProvider": "claude",
  "goal": "Keep the login request and UI behavior aligned.",
  "reason": "The request needs a coordinated API change.",
  "childTaskIds": []
}
```

`action` has three outcomes: `implement`, `delegate`, or `request_input`. The JSON is one final object; do not parse it from Markdown fences, raw logs, or arbitrary braces in prose. The adapter extracts the provider's final structured payload; engine validates it against the shared versioned schema. Backend independently validates persistent constraints and authorization.

For `implement`, require a nonempty scope, goal and eligible execution provider. For `delegate`, require staged child IDs belonging to this revision and optionally one staged verification task; child scopes fit the final parent scope, independently of repo hints. Verification uses the parent's conversation and a bounded prerequisite set. For `request_input`, require a plain question; unresolved repos/provider may be absent. Engine commits one HITL request, without a second MCP question side effect. Reject mixed outcomes, unknown IDs/providers, invalid priority, empty title, or wrong parents. Preserve submitted title/priority overrides.

Persist the accepted result, same-conversation history high-watermark, input revision, routing-policy version/hash and provider choices. Stream completion alone cannot finish a task. Accepted `delegate` finishes the parent only after verified stop and atomic handoff. Raw JSON stays in execution metadata; chat gets a short decision summary and any question. Bound captured output and history.

## Admission has two concrete purposes

**Intake attempt:** Atomic claim creates a run with purpose `intake`, independent task ownership/fencing and one global slot, without repo locks. Its cwd is an app-owned scratch directory. It has only the scoped task/chat MCP tools needed for Intake; no code-writing tools or ambient MCP servers. A prompt alone is not a read-only guarantee.

After validated output and verified process-tree stop, atomically commit resolution, finish the Intake run, revoke its token and release its slot. `implement` returns the same task to `todo` with internal stage `ready`; this is not a task-level `done`. A task waiting for a busy repo has no active process, slot or partial locks. Scheduler can admit other eligible scopes.

For Intake `request_input`, persist a request bound to task/input revision and the stopped Intake attempt; task becomes `hitl`, without a retained active run or slot. Extend HITL pairing to distinguish this checkpoint from implementation HITL. One matching reply appends the answer and queues fresh Intake atomically; stale/duplicate replies cannot queue another attempt. User waiting time is outside a running Intake deadline. Cancel at this checkpoint cancels the task and its staged children directly.

**Implementation attempt:** Atomic admission creates a new run and slot and acquires every resolved canonical path, or acquires nothing. Preserve P0–P3/FIFO over eligible work, 100ms polling and `min(configured concurrency, 8)`. Carry one per-path fencing generation plus a distinct run ownership fence; a single generation is insufficient across several repos. Heartbeat, event authorization, cancel, finalize and quarantine validate the complete owned lock set. Single-repo attempts follow the same invariant without requiring a second protocol.

Use a primary cwd from the accepted scope and additional explicitly allowed registered roots. A shared ancestor/rootWorkspace is not a grant to sibling repos. Never add a path to a live writer. If a provider cannot enforce the scope, block that route; do not silently drop repos or bypass permissions.

After implementation HITL, retain all write locks as required by the existing retained-run policy. Uncertain implementation stop quarantines the entire owned set and retains its global reservation. Uncertain Intake stop retains its run/slot reservation and forbids a successor for that task. Admission counts unresolved attempts as occupied, not only `running` and `hitl` labels.

Intake has a proposed 120-second attempt deadline. Implementation retains its 60-minute deadline from its own writer claim. This is an intentional two-attempt budget; restart, reconnect and retained-run HITL never reset a deadline. A reply to a stopped Intake checkpoint starts a new bounded Intake attempt. There is no automatic provider fallback, repeated semantic repair loop, or retry after timeout/invalid output. Transport retries reuse the original request identity. Explicit retry reuses valid resolution only for an unchanged, previously accepted input/policy/scope; failed Intake is retried as Intake.

## Child creation stays MCP-owned

Intake calls `create_task` with Message, its own task ID as `parentId`, optional fields, and stable child identity. Backend rejects any other parent and preserves depth one / maximum five children. At accepted handoff, bound child authorization to the parent's accepted repo scope; child repo hints still do not constrain selection within that authorized set. Protocol keys derive from durable Intake revision and child identity, surviving a restarted provider run; changed payload with the same identity is a conflict.

Children are persisted but staged and unrunnable until Intake result acceptance and verified stop. This avoids partial execution before valid JSON. Duplicate MCP calls return the same child. Invalid output or interrupted Intake leaves children blocked for explicit retry/cancel; cancelling or superseding an Intake cancels its staged children. Already activated children are never silently replaced or replayed.

On `delegate`, atomically finish the verified-stopped parent as `done`, release its slot/locks, and activate children. Parent completion records successful delegation, not child success. Never park, requeue or resume that parent. If verification is needed, create a distinct task in the parent's conversation; its bounded prerequisite set prevents early execution. Child terminal results make that new task eligible, including failure/cancel results for diagnosis. See [delegation and follow-up](04-delegation-and-follow-up.md). No implicit sibling order is promised.

## REST, internal API and events

| Surface | Delta |
|---|---|
| Public task create / MCP `create_task` | Message-only accepted; optional title/priority, repo hints, managed parent, authorized conversation reuse and bounded verification prerequisites. |
| Task read/list/context | Task's initial-message reference, conversation ID, nullable metadata, repo scope, internal stage, provider, revisions and prerequisite IDs. History stays within that conversation. |
| Task update / chat | Remove Description; new input invalidates pending resolution at a safe boundary. Distinguish stopped Intake questions from retained implementation HITL. |
| Shared chat / HITL | Persist message origin task/run and route replies by explicit task/request identity; never select an arbitrary task by conversation ID. |
| Internal admission | Returns purpose, deadline, ownership fence, and a repo lock set for implementation. Both bulk admission and direct claim must enforce the same rules. |
| Internal Intake result commit | Engine-only, fenced, idempotent acceptance; checks revision, outcome, children/follow-up and stop proof; delegation completes the parent atomically. |
| Adapter start/capabilities | Purpose, allowed roots, tool profile and structured result support; unsupported profiles fail explicitly. |
| Browser SSE | Invalidate metadata/stage changes after commit; REST remains authoritative on reconnect. |

Create, result commit and child creation support payload-hash receipts. Browser/SDK clients supply stable request identities automatically; REST can use `Idempotency-Key`, MCP an optional protocol key. Keys are not extra user form fields. Message-only calls without keys are accepted, but retrying them after a lost response can create another task; do not deduplicate by Message text.

Existing Zod contracts remain the source of truth at implementation. No OpenAPI/Postman artifact was found in the inspected project; this plan does not introduce a parallel schema or require Postman workspace setup.

## Migration and compatibility

- Back up the stopped instance; use forward migrations for unresolved metadata, scope, stage, ownership, hints, resolution, message-task attribution, conversation reuse and verification prerequisites. Preserve runs, receipts, FKs and lock generations.
- Convert each legacy nonempty Description into exactly one initial user message, preserving Markdown. If absent, use its title as Message. An idempotent migration mapping prevents duplicate chat insertion. Preserve existing conversations and their order.
- Backfill a single-repo scope for old tasks. Preserve their title, priority and provider as legacy constraints. Do not reroute an active or terminal legacy task on upgrade; new attempts honor that compatibility policy.
- Preserve existing waiting-parent flows under their legacy lifecycle version until safely resolved; do not silently mark them done during migration. New feature tasks use terminal delegation. Backfill message origins from source run/task and legacy single-task conversations before permitting shared conversations.
- During one release, legacy requests lacking Message map nonblank Description, or Title if Description is absent, into Message. When both Message and Description are present, reject conflicting bodies; matching bodies map once. Deprecate the adapter explicitly, then remove Description from wire DTOs. Deprecated storage may remain until a later safe cleanup; it is not a second source of truth.
- Stop incompatible old engines/adapters during migration and reject mixed internal protocol versions. Ship frontend/contracts/services together. Reverting binaries cannot safely consume the new DB shape; rollback requires a stopped instance and backup restore, with post-backup work handled explicitly.

## Advanced: inspected baseline and required amendments

The inspected checkout already has uncommitted changes, including Agy, harness settings, frontend changes and layered extraction. Re-inspect those changes at implementation; do not replay completed refactors or overwrite them.

- [Task contracts](../../src/contracts/task.ts) require title/repo and default priority immediately. [Task creation](../../src/backend/domains/task/usecases/create-task-usecase.ts) copies the repo provider and creates no initial chat message.
- [Intake context boundary](../../src/backend/domains/task/usecases/get-task-context-usecase.ts) currently requires one repository. [Claim](../../src/backend/domains/task/usecases/claim-task-usecase.ts) and [admission](../../src/backend/domains/task/usecases/admit-next-task-usecase.ts) assume one lock; several precondition reads precede the write transaction. All admission reads/checks/writes must move inside one immediate transaction for safe multi-connection contention.
- [Managed MCP](../../src/backend/mcp/tools.ts) currently forces children into the parent's repo; [tokens](../../src/backend/mcp/tokens.ts) do not carry a managed repo set. Both require bounded candidate/resolved scope support.
- [Message repository](../../src/backend/domains/chat/repositories/message-repository.ts), [list](../../src/backend/domains/chat/usecases/list-messages-usecase.ts) and [HITL replies](../../src/backend/usecases/reply-hitl-usecase.ts) choose one task from a conversation. [Message storage](../../src/backend/domains/chat/schema.ts) lacks a persisted origin task ID. Shared conversations must remove that single-task assumption and preserve exact message/reply attribution.
- [Runtime](../../src/execution-engine/runtime.ts) drops the claim deadline before dispatch and continues admission after failed startup listing. [Adapter timeout](../../src/agent-adapter/manager.ts) records verified stop without awaiting cancellation. Repair and prove these before adding another lifecycle stage.
- [Occupancy](../../src/backend/domains/task/repositories/run-repository.ts) counts only running/HITL; [uncertain recovery](../../src/backend/domains/task/recovery.ts) changes run status to uncertain. Retain uncertain reservations explicitly in the shared cap.
- Amend [AGENTS](../../AGENTS.md) §2/§5/§8, [constitution](../CONSTITUTION.md) I.2 for scratch-only Intake cwd, [PRD](../2026-10-18-initialize-project/PRD.md), [specification](../2026-10-18-initialize-project/SPECIFICATION.md) T-01/C-01/E-01–03 and [architecture](../ARCHITECTURE.md) data/claims/HITL/MCP sections as part of implementation. These documents are not silently amended by the proposal.
