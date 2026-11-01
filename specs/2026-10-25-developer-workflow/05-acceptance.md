# Acceptance matrix

## TL;DR

- **Goal:** Verify the three features through their real user and harness boundaries.
- **Key decision:** Use contract, backend integration, process, and browser interaction checks; no unit tests or screenshots.
- **Impact:** Disposable data/repositories only; actual desktop delivery requires separate OS evidence.

## Scope

### In scope

| Item | Readiness | Evidence required |
| --- | --- | --- |
| Template contracts and compatibility | **Ready** | HTTP/MCP responses, persisted task snapshots, row/event counts. |
| Notification and draft behavior | **Ready** | Browser interaction assertions against a real app/backend. |
| Desktop presentation | **Assumption — review** | Manual observation at the target loopback origin; report browser/OS/version and permission state. |

### Out of scope

Performance benchmark project, full provider certification, cross-OS claims from macOS-only checks, unit tests, image capture, and changing unrelated runtime behavior.

## Template acceptance

| ID | Scenario | Pass condition |
| --- | --- | --- |
| T01 | Discover templates via allowed MCP scope and browser REST | Three matching immutable entries; exact schema, skeleton, guidance, and limits. |
| T02 | Caller lacks catalog scope | Tool absent from `tools/list`; direct call forbidden; authorized `create_task` remains usable. |
| T03 | Each template through external MCP JSON-RPC | Valid task/conversation persisted with exact description and normal Task response. |
| T04 | REST/direct-MCP/managed creation parity | Equivalent inputs yield the same rendered description; role-specific repo/parent rules remain. |
| T05 | Legacy free-form creation and receipt replay | Payload/response behavior and existing receipt hashes remain compatible. |
| T06 | Missing/unknown template, invalid fields, mixed modes, input limits | `VALIDATION_ERROR` with field details; zero task/conversation/receipt/event side effects. |
| T07 | Repeat, concurrent repeat, restart, upgrade with immutable v1 renderer | External key creates exactly one task/conversation; same retry returns it; one creation event. |
| T08 | Changed payload with the same external key | Existing `SEQUENCE_CONFLICT`; no extra writes. Managed same-key replay retains first-result behavior. |
| T09 | Managed retry at five-child ceiling; new sixth child; grandchild | Replay succeeds; only new excess children fail; parent/repo/token restrictions hold. |
| T10 | Old server and scope upgrade | Harness detects missing template fields before send; existing tokens are not auto-expanded. |
| T11 | New catalog route authorization | Missing/wrong browser credentials and bad Host/Origin rejected under production auth. MCP credentials do not become browser credentials. |
| T12 | Template edit/retry and UI picker | Stored description does not re-render on retry; mode change cannot silently erase fields. |

## Notification acceptance

| ID | Scenario | Pass condition |
| --- | --- | --- |
| N01 | MCP-created task becomes HITL/done/error on Dashboard | Correct eligible notice without opening Workspace first. |
| N02 | Workspace, background tab, and visible selected conversation | Other tasks notify; focused selected chat is quiet; background desktop obeys opt-in. |
| N03 | HITL publishes input and status events, including duplicates | One semantic notice per request ID. |
| N04 | Status-preserving update, old version, already resolved HITL | No new notice; REST current state governs. |
| N05 | Initial load, reconnect, backend sequence reset, events during baseline | No historical/baseline notices; snapshot reconciles correctly; no durable replay claim. |
| N06 | Two same-origin tabs, concurrent event delivery, lock delay | At most one desktop attempt for the same semantic identity; state rechecked after lock. |
| N07 | Permission default/denied/granted/revoked; unsupported context/API | No automatic permission prompt; clear status and functional in-app fallback. |
| N08 | Storage unavailable or coordination missing | Desktop disabled; task/chat/live state still works. |
| N09 | Direct link, query-only task change, Back/Forward, filtered task | Exact task revealed; saved grouping retained; missing/forbidden ID handled. |
| N10 | Route switch/repeated mount/unmount/landing page | One SSE connection per mounted app page; no leaked subscriptions; zero on landing. |
| N11 | Category switches, disabled delivery, burst, focus/accessibility | Preferences honored; bounded notices; keyboard Open/Dismiss; no focus theft or sound. |
| N12 | All app pages closed | No delivery promise; reopen reconciles task state without announcing history. |
| N13 | Actual desktop presentation on macOS target browser | Notice appears when allowed, click focuses the authenticated page and opens task. Record separately from simulated API checks. |
| N14 | Notice content and deep link | No question body, credentials, repository path, raw logs, or auth token in notice/link. |

## Draft acceptance

| ID | Scenario | Pass condition |
| --- | --- | --- |
| D01 | Edit task A, switch to B, stream updates, return to A | Independent text restored; server updates never erase it. |
| D02 | Reload, Dashboard navigation, reopen same origin/profile | Saved chat/form values restored without submission. |
| D03 | A send resolves after selecting B or typing more in A | Only acknowledged revision cleared; B/newer text preserved. |
| D04 | Failed/timeout submission and SSE message arrival | Draft retained; no automatic resend or inferred acknowledgement. |
| D05 | HITL request changed/resolved while draft was saved | Text kept, stale target blocked, explicit reuse required; backend stale-request checks remain. |
| D06 | Two tabs save; one acknowledges an older revision | With storage coordination, newer stored record not deleted; restore uses latest saved record. Without it, parallel-edit limitation is visible; active text stays intact. |
| D07 | Storage denied/full, oversized record, total limit, corrupt/unknown version | Editor usable; no truncation/other-draft eviction; honest unsaved hint and discard path. |
| D08 | Create form close/cancel, template switch, backend rejection | Complete draft retained; Replace/Keep enforced; unsuccessful submission never clears it. |
| D09 | Repo/catalog still loading, removed repo/template, new prefilled parent | Text preserved; no silent repo replacement; explicit target correction required. |
| D10 | Explicit discard and successful create/send | Correct matching revision removed; unrelated drafts and credentials untouched. |
| D11 | Draft for forbidden/missing task; local record inspection | Draft not shown before authorization; no tokens/full Task objects stored. |
| D12 | Page hidden before debounce ends and crash before save | Lifecycle flush verified; documented last-300-ms crash limit remains honest. |

## Combined gate and evidence

Run **MCP discover/create → task starts → HITL → one notice → Open → write draft → reload → explicit reply → task completes → one completion notice**. A deterministic fake provider may drive this flow; the backend, HTTP/MCP, and browser must be real. This proves the TaskAside workflow, not new Codex/Claude capabilities.

Record the current six statuses, P0–P3 grouping, repository-bound provider choice, cancel/retry, snapshot reconnect, and single-writer/fencing checks as regression gates. Notification permission failures and storage failures cannot mutate a run or free a lock.

For each check record **planned / passed / failed / blocked / unverified**, the exact command or interaction, runtime/browser/OS versions, whether a provider/API was simulated, and any pre-existing failure. This file defines acceptance only; **no application checks have run for this planning change**.
