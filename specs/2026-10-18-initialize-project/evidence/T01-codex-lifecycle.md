# T01 — Codex lifecycle evidence (macOS)

**Date:** 2026-10-18
**Platform:** macOS, Darwin 25.6.0, arm64
**CLI:** `codex-cli 0.163.0` (installed via Homebrew, existing local login/config; no separate API credential used)
**Disposable repo:** `/tmp/taskaside-test-codex-repo` (created, exercised, and removed during this evidence run; not part of the TaskAside workspace)

## 1. Setup

```bash
mkdir -p /tmp/taskaside-test-codex-repo
cd /tmp/taskaside-test-codex-repo
git init -q
git config user.email "test@taskaside.local"
git config user.name "TaskAside Test"
echo "# TaskAside Codex Test Repo" > README.md
git add README.md
git commit -q -m "initial commit"
```

Result: repo created with one commit (`9fd6b45 initial commit`). Repo removed with `rm -rf /tmp/taskaside-test-codex-repo` at the end of this evidence run.

## 2. Verified CLI flags

Confirmed via `codex exec --help` and actual runs:

| Flag | Confirmed behavior |
|---|---|
| `exec` | Non-interactive subcommand; prompt as arg or stdin |
| `--cd <DIR>` | Sets agent working root |
| `--sandbox <read-only\|workspace-write\|danger-full-access>` | Enforced OS-level sandbox policy |
| `--approve-for-me` | Routes approvals through automatic review **using workspace-write sandbox**; **cannot be combined with `--sandbox`** (clap arg conflict, see §5) |
| `--ephemeral` | Runs without persisting session files to disk |
| `--json` | Streams JSONL events to stdout |
| `-o, --output-last-message <FILE>` | Writes only the final agent message (not exercised in this run; event JSONL was captured instead per task spec) |
| `--skip-git-repo-check` | Allows running outside a git repo (not needed here; repo was git-initialized) |

**Correction to assumed flag combination:** the skill and task instructions suggest `--sandbox workspace-write --approve-for-me` together. This **fails** on the installed 0.163.0 CLI:

```
error: the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'
```

`--approve-for-me` already implies/selects the workspace-write sandbox internally. Correct invocation for an auto-approved writable run is `--approve-for-me` **without** an explicit `--sandbox` flag.

## 3. Read-only mode

Command:

```bash
codex exec --cd /tmp/taskaside-test-codex-repo --sandbox read-only --ephemeral --json \
  "List the files in this directory" > events-readonly.jsonl
```

- Exit code: `0`
- Fixture: `specs/2026-10-18-initialize-project/evidence/fixtures/codex/events-readonly.jsonl` (7 JSONL lines; owner username redacted to `redacted-user`)
- Event sequence observed: `thread.started` → `turn.started` → `item.completed` (agent_message) → `item.started` (command_execution, `ls -la`) → `item.completed` (command_execution, with `aggregated_output` and `exit_code:0`) → `item.completed` (agent_message, final answer) → `turn.completed` (with token `usage`).
- The shell command ran under the enforced read-only sandbox; no file mutation occurred (confirmed by directory listing after the run).
- stderr printed one informational line: `Reading additional input from stdin...` (benign; CLI checks stdin even when the prompt is given as an argument).

## 4. Workspace-write mode

Command (corrected per §2 — no explicit `--sandbox` alongside `--approve-for-me`):

```bash
codex exec --cd /tmp/taskaside-test-codex-repo --approve-for-me --ephemeral --json \
  "Create a file named hello.txt containing 'Hello from Codex'" > events-write.jsonl
```

- Exit code: `0`
- Fixture: `specs/2026-10-18-initialize-project/evidence/fixtures/codex/events-write.jsonl` (7 JSONL lines)
- Verified file mutation: `/tmp/taskaside-test-codex-repo/hello.txt` created, content exactly `Hello from Codex`.
- Event sequence observed: `thread.started` → `turn.started` → `item.completed` (agent_message) → `item.started` (`file_change`, `kind:"add"`, target path) → `item.completed` (`file_change`, `status:"completed"`) → `item.completed` (agent_message, final summary) → `turn.completed` (usage).
- No approval prompt blocked the run; `--approve-for-me` auto-approved the file write as intended for a non-interactive harness.

## 5. Cancellation behavior

Started a long-running prompt (long essay) under `--sandbox read-only --ephemeral --json` in the background, sent `SIGTERM` after 2s, checked liveness after 1s:

```
STARTED_PID=34954
SENT_SIGTERM
<shell> line 12: 34954 Terminated: 15   codex exec ...
PROCESS_TERMINATED
```

- Process received `SIGTERM` and terminated within the 1s check window — no hang observed.
- Partial JSONL output on disk showed only `thread.started` and `turn.started` (no `turn.completed`), confirming the stream was cut mid-turn rather than completing gracefully.
- Finding for adapter design: `codex exec` does not emit an explicit `cancelled` event type on SIGTERM; cancellation must be inferred from process exit + absence of a terminal event (`turn.completed`/`turn.failed`), consistent with architecture's "distinguish provider turn completion from verified absence of a writer."

## 6. Failure handling

Forced a provider-side error using an invalid model:

```bash
codex exec --cd /tmp/taskaside-test-codex-repo --sandbox read-only --ephemeral --json \
  --config model="nonexistent-model-xyz" "say hi"
```

- Exit code: `1`
- Event sequence: `thread.started` → `item.completed` (`type:"error"`, degraded-metadata warning) → `turn.started` → `item.completed`/top-level `error` event with a structured JSON error body (`status:400`, `invalid_request_error`) → `turn.failed` with the same structured `error` object.
- Finding: failures surface as a **typed terminal event** (`turn.failed`) with a machine-parseable `error.message` payload (itself a JSON string in this case), plus a non-zero process exit code. Both signals agree — no case observed where exit code and event stream disagreed.

## 7. `codex app-server` probe

```bash
codex app-server --help
```

- Subcommands: `daemon`, `proxy`, `generate-ts`, `generate-json-schema`, `help`.
- Transport: `--listen <URL>` supports `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`; `--stdio` shorthand.
- WebSocket auth: `--ws-auth <capability-token|signed-bearer-token>`, plus token/shared-secret file and issuer/audience/clock-skew options — i.e., app-server has a real authenticated remote-transport mode, not just local stdio.
- Marked **`[experimental]`** at the top-level help banner — this is an explicit upstream signal that the protocol is not yet stable/pinned.

### Protocol generation

```bash
codex app-server generate-json-schema --out <dir> --experimental
codex app-server generate-ts --out <dir> --experimental
```

Both require `--out <DIR>`; both exited `0` and wrote a full schema/bindings bundle (JSON Schema run produced ~49 top-level files plus versioned `v1/`/`v2/` directory trees and two bundled schema files, one ~890KB, one ~776KB — not copied into fixtures due to size/irrelevance to lifecycle evidence; regenerable on demand with the commands above).

Representative method/type families found in `ClientRequest`/`ServerNotification`:

- **Thread/turn control:** `ThreadStartParams`, `ThreadResumeParams`, `ThreadForkParams`, `ThreadResumeInitialTurnsPageParams`, `TurnStartParams`, `TurnInterruptParams`, `TurnSteerParams`, `TurnSettingsUpdateParams`, `TurnEnvironmentParams`.
- **Approvals (HITL/privileged actions):** `ApplyPatchApprovalParams`/`Response`, `ExecCommandApprovalParams`/`Response`, `CommandExecutionRequestApprovalParams`/`Response`, `PermissionsRequestApprovalParams`/`Response`, `FileChangeRequestApprovalParams`/`Response`, plus guardian review action types (`CommandGuardianApprovalReviewAction`, `ExecveGuardianApprovalReviewAction`, `ApplyPatchGuardianApprovalReviewAction`).
- **MCP-related:** `McpServerElicitationRequestParams`/`Response`, `McpResourceReadParams`, `McpServerEventStreamStartParams`, `ListMcpServerStatusParams`.
- **Tool/user input:** `ToolRequestUserInputParams`/`Response`, `DynamicToolCallParams`/`Response`.
- **Items/streaming:** `AgentMessageThreadItem`, `CommandExecutionThreadItem`, `ContextCompactionThreadItem`, `ErrorNotification`, `ActiveThreadStatus`.

## 8. Protocol comparison: `codex exec --json` vs `codex app-server`

| Aspect | `codex exec --json` | `codex app-server` |
|---|---|---|
| Transport | One-shot process, JSONL on stdout | Long-lived JSON-RPC 2.0 over stdio/unix-socket/websocket |
| Stability | Stable enough for scripted harness use (per M0 skill guidance) | Top-level help marked `[experimental]`; method surface (thread/turn/approval/MCP) is large and versioned (`v1`/`v2` schema dirs), implying active churn |
| Session/resume | No resume flag observed for `exec` itself beyond `codex exec resume`/`fork` subcommands (present in help, not exercised here) | First-class `ThreadResumeParams`, `ThreadForkParams`, `ThreadResumeInitialTurnsPageParams` |
| Cancellation | Only OS signal (SIGTERM); no explicit `cancelled` event type observed | Explicit `TurnInterruptParams` request — a structured cancel, not just a signal |
| Approvals | `--approve-for-me` (blanket auto-review) or sandbox-enforced denial; no per-action approval channel in the JSONL stream observed | Dedicated per-action approval request/response pairs (exec, patch, file-change, permissions) — a real HITL channel |
| MCP | Not exposed by `exec` | Explicit MCP elicitation/resource/event-stream methods |
| Fit for TaskAside | Good for a stateless, fire-and-forget run (matches `StartRun`/`completed`/`failed` baseline) | Better match for `input_required`, `resume`, and scoped MCP per ARCHITECTURE.md §6, but is explicitly experimental and larger to integrate safely |

## 9. Limits observed

- **Approval handling:** `--approve-for-me` is all-or-nothing for the `exec` baseline — it does not expose discrete per-action approval/deny decisions to the calling harness; it is a blanket auto-review policy applied by Codex itself. Fine-grained, per-action HITL (matching ARCHITECTURE.md's `input_required`/provider-permission distinction) is only visible in the `app-server` approval method family, not in `exec`.
- **MCP support:** No MCP configuration/flag surfaced in `codex exec --help`. MCP methods only appear in the `app-server` protocol schema. `exec`-based baseline cannot satisfy ARCHITECTURE.md §6's "configures scoped MCP" requirement for the Codex driver (T17) — that requirement points at `app-server`, not `exec`.
- **HITL support:** Not demonstrated end-to-end in this evidence run (no prompt in these POCs triggered a real approval pause under `exec`); the schema shows the request/response shapes exist in `app-server`, but runtime behavior (does a paused turn hold the process, can it be resumed) is **not verified** here and remains an open POC item.
- **Session resume/yield:** Not exercised in this task. `codex exec resume`/`fork` subcommands and `app-server`'s `ThreadResumeParams` exist per `--help`/schema, but actual resume semantics (what state transfers, whether a paused run can be safely resumed by a different process) are unverified.
- **Cancellation signal only:** `exec` cancellation was proven safe (process dies within 1s of SIGTERM, no hang) but produces no terminal event — the adapter must treat "process exited without `turn.completed`/`turn.failed`" as the cancellation signal, consistent with CONSTITUTION.md IV.3 ("a dead heartbeat alone does not prove... stopped").
- **`--sandbox`/`--approve-for-me` conflict:** documented in §2; any adapter code or docs assuming both flags can be passed together is wrong for 0.163.0.

## 10. Recommendation for TaskAside agent-adapter Codex driver

1. **MVP baseline should use `codex exec --json`** (not `app-server`) for the first Codex driver, matching the shared `AgentEvent` contract in ARCHITECTURE.md §6: map `item.completed` (agent_message) → `message.completed`, `turn.completed` → `completed`, `turn.failed` → `failed`, process-exit-without-terminal-event → `cancelled`. This keeps the driver on the CLI surface that is documented as stable enough for scripted harnesses (per the M0 skill), not the `[experimental]` app-server protocol.
2. **Do not claim MCP or granular HITL support for the `exec`-based driver.** Per CONSTITUTION.md VI.3, report these as explicit capability gaps (`GET /capabilities` returns `mcp: false`, `hitl: false` or similar) rather than faking them with text parsing.
3. **Treat `app-server` as the candidate path for a later, explicitly-scoped iteration** once MCP/fine-grained-approval/resume are required (T17 in PLAN.MD already anticipates this), but only after a dedicated POC against its `[experimental]` protocol, since the schema surface is large and versioned (`v1`/`v2`) and may change between Codex releases. Pin and re-verify the protocol version before building on it, per ARCHITECTURE.md's Codex driver note.
4. **Cancellation:** adapter should send SIGTERM to the process group, wait a bounded interval (this evidence used 1s and observed clean termination), and verify absence of a terminal JSONL event before confirming cancellation — do not rely on a `cancelled` event that `exec` does not emit.
5. **Approval mode:** use `--approve-for-me` for workspace-write runs in MVP (never combine with `--sandbox`); this is coarse but auditable, and matches "least powerful mode that can finish the task" guidance — a stricter per-action approval loop requires `app-server`.
6. **Failure detection:** treat `turn.failed` event **and** non-zero exit code as the dual signal of failure (both agreed in this evidence); do not rely on exit code alone since partial JSONL may still be useful for diagnostics.

## 11. Changed/created files

- `specs/2026-10-18-initialize-project/evidence/T01-codex-lifecycle.md` (this report)
- `specs/2026-10-18-initialize-project/evidence/fixtures/codex/events-readonly.jsonl`
- `specs/2026-10-18-initialize-project/evidence/fixtures/codex/events-write.jsonl`
- Scratch (not part of evidence, local-only): `.taskaside-implementation/scratch/*.sh`, `*.log`, `*.txt`, `*.stderr` — raw help output and intermediate logs kept for traceability but not duplicated as fixtures since the task asked for `events-readonly.jsonl`/`events-write.jsonl` specifically.

Disposable repo `/tmp/taskaside-test-codex-repo` was removed after all checks completed.
