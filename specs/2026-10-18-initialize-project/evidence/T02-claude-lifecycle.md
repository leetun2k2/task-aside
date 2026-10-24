# T02 — Claude lifecycle evidence (macOS)

**Date:** 2026-10-18
**Platform:** macOS, Darwin 25.6.0, arm64
**CLI:** `claude 2.1.267 (Claude Code)` (existing local login/config; no separate API credential used)
**Bun:** `1.4.3`
**Disposable repo:** `/tmp/taskaside-test-claude-repo` (created, exercised, and removed during this evidence run; not part of the TaskAside workspace)

## 1. Setup

```bash
mkdir -p /tmp/taskaside-test-claude-repo
git -C /tmp/taskaside-test-claude-repo init -q
git -C /tmp/taskaside-test-claude-repo config user.email "test@taskaside.local"
git -C /tmp/taskaside-test-claude-repo config user.name "TaskAside Test"
# README.md written, then:
git -C /tmp/taskaside-test-claude-repo add README.md
git -C /tmp/taskaside-test-claude-repo commit -q -m "initial commit"
```

Result: repo created with one commit (`9ffa961 initial commit`). Repo removed with `rm -rf /tmp/taskaside-test-claude-repo` at the end of this evidence run.

**Harness note:** this session's Bash tool blocks compound `cd DIR && cmd` / `cmd > file` patterns with no approval surface available. All commands below were run either as single non-chained invocations (`git -C <dir> ...`), or via small shell scripts under `.taskaside-implementation/scratch/*.sh` invoked with `sh`, per the task's allowed-pattern guidance. This is a harness-session quirk, not a `claude`/Bun finding.

## 2. Verified CLI flags

Confirmed via `claude --help` and actual runs:

| Flag | Confirmed behavior |
|---|---|
| `-p, --print` | Non-interactive mode; prompt as trailing arg |
| `--permission-mode <mode>` | `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` |
| `--permission-prompts <host\|none>` | `none` denies anything that would prompt instead of blocking for input — required for unattended runs |
| `--no-session-persistence` | Print-mode only; disables saving to disk (and thus disables `--resume` for that run) |
| `--output-format <text\|json\|stream-json>` | `stream-json` streams JSONL events to stdout |
| `--disallowedTools <tools...>` | Comma/space-separated tool denylist; verified `Edit,Write,NotebookEdit,Bash` removes those names from the session's `tools` array |
| `--allowedTools <tools...>` | Present in `--help`; not separately exercised here (denylist was sufficient for the read-only scenario) |
| `--mcp-config <configs...>` | Loads MCP servers from a JSON file/string; verified |
| `--strict-mcp-config` | Restricts the session to only `--mcp-config` servers, ignoring the invoking user's `~/.claude` MCP configuration; verified |
| `--session-id <uuid>` | Pins the session id for a print-mode run; verified |
| `--resume <session-id>` | Resumes a previously persisted session in a **new process**; verified end-to-end |
| `--model <model>` | Verified failure path with an invalid value |

## 3. Read-only mode

Command (see `.taskaside-implementation/scratch/run_readonly.sh`):

```bash
claude -p \
  --disallowedTools "Edit,Write,NotebookEdit,Bash" \
  --permission-prompts none \
  --no-session-persistence \
  --output-format stream-json \
  --verbose \
  "List the files in this directory"
```

- Exit code: `0`
- Fixture: `specs/2026-10-18-initialize-project/evidence/fixtures/claude/events-readonly.jsonl` (redacted; large inherited arrays summarized — see §9)
- Event sequence observed: `system/hook_started` → `system/hook_response` (this project's `SessionStart` hook fired) → `system/init` (full session manifest: tools, MCP servers, skills, plugins) → `assistant` (thinking block) → `assistant` (`tool_use`, `Glob` with pattern `*`) → `rate_limit_event` → `user` (tool_result: file listing) → `assistant` (final text answer) → `result` (terminal, `subtype:"success"`, cost/usage totals).
- `Edit`, `Write`, `NotebookEdit`, `Bash` were **confirmed absent** from the `tools` array in `system/init` — the model used `Glob` instead of `ls`/`Bash` to answer, and no file mutation occurred.
- No permission-prompt stall observed; `--permission-prompts none` behaved as documented.

## 4. Workspace-write mode

Command (see `.taskaside-implementation/scratch/run_write.sh`):

```bash
claude -p \
  --permission-mode acceptEdits \
  --permission-prompts none \
  --no-session-persistence \
  --output-format stream-json \
  --verbose \
  "Create a file named hello.txt containing 'Hello from Claude'"
```

- Exit code: `0`
- Fixture: `specs/2026-10-18-initialize-project/evidence/fixtures/claude/events-write.jsonl` (redacted)
- Verified file mutation: `/tmp/taskaside-test-claude-repo/hello.txt` created, content exactly `Hello from Claude` (confirmed with `cat`).
- Event sequence observed: `system/hook_started` → `system/hook_response` → `system/init` (`tools` now includes `Edit`, `Write`, `NotebookEdit`, `Bash`; `permissionMode:"acceptEdits"`) → `assistant` (text) → `assistant` (`tool_use`, `Write`) → `rate_limit_event` → `user` (tool_result: file created) → `assistant` (final confirmation text) → `rate_limit_event` → `result` (terminal, success).
- No approval prompt blocked the `Write` call; `acceptEdits` auto-approved it as intended for a non-interactive harness.

## 5. Cancellation behavior

Started a long essay prompt under `--disallowedTools "Edit,Write,NotebookEdit,Bash" --permission-prompts none --no-session-persistence --output-format stream-json` in the background (see `.taskaside-implementation/scratch/run_cancel.sh`), sent `SIGTERM` after 2s:

```
STARTED_PID=36992
SENT_SIGTERM
TERMINATED_WITHIN_1S
NO_CLAUDE_PROCESSES_LINGERING (no `claude -p` process found in `ps -ef` after termination; matches against the desktop Claude.app helper processes were unrelated)
```

- Process received `SIGTERM` and exited within 1s — no hang, consistent with T01's Codex finding.
- Partial JSONL on disk (`events-cancel.jsonl`, copied to scratch) contained only `system/hook_started`, `system/hook_response`, `system/init` — no `result` terminal event, confirming the stream was cut mid-turn.
- Finding for adapter design: like `codex exec`, `claude -p` emits **no explicit `cancelled` event type**. Cancellation must be inferred from process exit + absence of a terminal `result` event, same pattern as T01 §5 and consistent with CONSTITUTION.md's "a dead heartbeat alone does not prove stopped" guidance (here it's "a dead process plus no terminal event proves stopped").

## 6. Failure handling

Forced a provider-side error using an invalid model (see `.taskaside-implementation/scratch/run_failure.sh`):

```bash
claude -p \
  --disallowedTools "Edit,Write,NotebookEdit,Bash" \
  --permission-prompts none \
  --no-session-persistence \
  --output-format stream-json \
  --verbose \
  --model nonexistent-model-xyz \
  "say hi"
```

- Exit code: `1`
- stderr: `[claude-code:unrecognized_model] {"model":"nonexistent-model-xyz","query_source":"sdk"}`
- Event sequence: `system/hook_started` → `system/hook_response` → `system/init` (`model:"nonexistent-model-xyz"` echoed back, no validation at init time) → `assistant` (synthetic message, `model:"<synthetic>"`, `error:"model_not_found"`, `is_api_error_message:true`, human-readable explanation) → `result` (terminal, `is_error:true`, `api_error_status:404`, `terminal_reason:"api_error"`).
- **Quirk worth flagging for the adapter:** the terminal `result` event's `subtype` field is still `"success"` even though `is_error:true` and `terminal_reason:"api_error"`. The adapter must branch on `is_error` / `terminal_reason`, **not** on `subtype`, to classify success vs. failure. (This differs from Codex, where `turn.failed` is the failure-indicating event type itself.)
- Both signals — non-zero exit code and `is_error:true` in the terminal event — agreed in this run.

## 7. Bun subprocess control

Script: `.taskaside-implementation/scratch/bun_claude_test.ts`. Uses `Bun.spawn` to launch `claude -p --output-format stream-json ...` with `stdout: "pipe"`, reads the stream via `getReader()`/`TextDecoder`, splits on newlines, and parses each line as JSON.

```bash
bun run .taskaside-implementation/scratch/bun_claude_test.ts
```

Output:

```
spawned pid=37108
exitCode=0
lineCount=9
eventTypes=["system","system","system","assistant","assistant","rate_limit_event","user","assistant","result"]
killed=true
```

- `Bun.spawn` launched the CLI, exposed a readable `stdout` stream, and line-by-line JSON parsing worked without buffering/encoding issues on macOS arm64.
- `proc.exited` resolved with the correct exit code (`0`) after the stream closed.
- Finding: Bun subprocess control is viable for the agent-adapter's Claude driver with no special handling beyond standard line-delimited JSON parsing (same approach needed for Codex's `--json` JSONL).

## 8. MCP capability probe

- `claude --help` confirms `--mcp-config <configs...>` (load MCP servers from JSON files/strings) and `--strict-mcp-config` (restrict session to only those servers).
- `claude mcp --help` exposes a full management subcommand tree: `add`, `add-from-claude-desktop`, `add-json`, `get`, `list`, `login`, `logout`, etc. — this operates on the **invoking user's persistent `~/.claude` config**, not a per-run scope.
- `claude mcp list` (no flags) printed ~38 servers from this machine's own Claude Code configuration (plugin MCP servers, claude.ai connectors) — **not** related to the disposable test repo. This confirms `claude mcp list`/`add` are user-machine-global commands, unsuitable for the adapter to call per-run; the adapter must instead use `--mcp-config`/`--strict-mcp-config` on each spawned process.
- **Custom MCP server test:** wrote `.test-mcp.json` defining a `test-fs` stdio MCP server (`npx -y @modelcontextprotocol/server-filesystem <repo>`), then ran:
  ```bash
  claude -p --mcp-config .test-mcp.json --strict-mcp-config \
    --disallowedTools "Edit,Write,NotebookEdit,Bash" \
    --permission-prompts none --output-format stream-json --verbose \
    "say hi, do not use any tools"
  ```
  Result: exit `0`; the `system/init` event's `mcp_servers` array was exactly `[{"name":"test-fs","status":"connected"}]` — **the ~38 ambient servers were fully suppressed**. This is the mechanism the adapter must use to scope a managed run to only its intended MCP server(s) (ARCHITECTURE.md's "Run-scoped MCP").
- **Answer to "can `--mcp-config` pass custom MCP servers?": yes**, confirmed working end-to-end (stdio transport), and `--strict-mcp-config` is required to prevent inheriting the operator's ambient MCP configuration.

## 9. Ambient-configuration leakage (important safety finding)

Every run in this evidence (unless `--strict-mcp-config` was used) inherited the **full invoking-user session context**:

- All ~38 MCP servers configured in this machine's `~/.claude` config (most `needs-auth`, some `connected`), visible in `system/init.mcp_servers` on every plain run.
- This repository's project `CLAUDE.md`-triggered `SessionStart:startup` hook fired and injected its instruction block as the first two JSONL events (`hook_started`/`hook_response`) in **every** run, including the disposable-repo runs — the hook is scoped to the Claude Code installation/session, not to the target working directory.
- Full inherited skill list, plugin list, and slash-command list (dozens of entries) appeared in `system/init` on every run.
- In the workspace-write run (§4), the model's first assistant message was *"This is a trivial file creation, not an API engineering task"* — a direct, visible side effect of the inherited Postman-plugin hook instructions shaping behavior on a task that has nothing to do with Postman.
- Cost impact: the trivial read-only listing cost **$0.16** and the trivial file write cost **$0.11** (per `total_cost_usd` in the terminal `result` events), driven almost entirely by `cache_creation_input_tokens` in the 18k–38k range — i.e., paying to re-ingest the operator's entire skills/plugins/MCP manifest on every single spawned turn.

**Implication for the agent-adapter:** spawning `claude -p` with only the flags shown in the task's "verified flags" list is **not** suffficient isolation for a managed run. Without `--strict-mcp-config` (to drop ambient MCP servers) and likely `--settings`/`--bare`/an isolated `$HOME` or `CLAUDE_CONFIG_DIR` (to drop ambient hooks, skills, plugins, CLAUDE.md auto-discovery), a TaskAside-spawned Claude run executes with the **operator's personal Claude Code configuration**, not a clean, auditable, run-scoped environment. This is a materially different risk profile than Codex's `exec --ephemeral`, which did not exhibit this in T01 (T01 did not probe this angle explicitly, but `codex exec` has no equivalent plugin/hook/skill inheritance surface). Recommend the adapter default to `--strict-mcp-config` plus `--bare` (or an isolated config directory) for every managed run, and treat any session that reports unexpected ambient tools/MCP servers as a configuration bug, not a cosmetic issue.

## 10. HITL / yield / session resume findings

Script: `.taskaside-implementation/scratch/run_resume.sh`.

**Turn 1** — fresh session, explicit id, persistence **on** (no `--no-session-persistence`):
```bash
claude -p --session-id 11111111-1111-4111-8111-111111111111 \
  --disallowedTools "Edit,Write,NotebookEdit,Bash" --permission-prompts none \
  --output-format stream-json --verbose \
  "Remember the secret word is PINEAPPLE. Reply with just OK."
```
Result: exit `0`, final `result:"OK"`.

**Turn 2** — separate process, resuming by session id:
```bash
claude -p --resume 11111111-1111-4111-8111-111111111111 \
  --disallowedTools "Edit,Write,NotebookEdit,Bash" --permission-prompts none \
  --output-format stream-json --verbose \
  "What is the secret word I told you?"
```
Result: exit `0`, final `result:"PINEAPPLE"`.

- **Session resume across separate OS processes is confirmed working** in print mode: `--session-id` pins an id on creation, `--resume <id>` continues it later from a brand-new `claude -p` invocation, and conversation memory (the secret word) carried over correctly.
- `--no-session-persistence` is mutually exclusive in effect with resume: using it (as in §3/§4/§5/§6) means that session cannot later be resumed — confirmed by omission in this test and explicit in `--help` ("only works with --print" / disables saving to disk).
- **Not verified in this task:** true mid-turn HITL (a paused turn waiting on a permission prompt or tool-approval, held open, then answered). All scenarios here used `--permission-prompts none` (auto-deny, no pause) or `acceptEdits` (auto-approve, no pause) — by design, these never produce a genuine pending-approval pause for an unattended harness to observe. Proving a real interactive pause-and-resume for a privileged tool action would require `--permission-prompts host` with a permission-prompt tool wired up, which is out of scope for a non-interactive M0 proof and is **correctly deferred** (per ARCHITECTURE.md, "session resume/HITL remain POC-gated").
- Multi-turn continuation in print mode therefore works at the **session/conversation level** (new process, same session id, prior context available) but this evidence does not prove **mid-run process retention** (ARCHITECTURE.md's `hitl → processing: Resume retained paused process`) — each `claude -p` invocation here was a complete, separate process lifecycle, not a long-lived process that paused and was later signaled to continue without restarting.

## 11. Limits observed

- **No explicit `cancelled` or `failed` event type on the wire** — the adapter must use "process exited, no terminal `result` event" for cancellation, and `is_error`/`terminal_reason` (not `subtype`) on the terminal `result` event for failure classification (§6).
- **Ambient configuration inheritance** is the most significant limit found (§9): every flag combination in the task's base command list still inherits the operator's full MCP/hook/skill/plugin configuration unless `--strict-mcp-config` (and probably `--bare`/isolated config dir) is also passed. This is a correctness and safety gap relative to ARCHITECTURE.md's "Run-scoped MCP" requirement if left unaddressed.
- **`claude mcp` subcommands are user-machine-global**, not run-scoped — the adapter cannot use `claude mcp add` per task/run; it must generate a temporary `--mcp-config` JSON file per run instead.
- **True mid-turn HITL pause/resume of a single retained process is not demonstrated** here (§10) — only cross-process session resume via persisted session id. Whether a privileged-tool approval can hold a live process open (vs. requiring a brand-new `--resume` invocation after the fact) remains unverified and should stay POC-gated per ARCHITECTURE.md.
- **Cost overhead from ambient inheritance** (§9): tens of thousands of cache-creation tokens per trivial turn when ambient config isn't stripped — a real cost/latency concern for a scheduler dispatching many short tasks.

## 12. Limits and capabilities comparison with Codex (T01)

| Aspect | Codex (`exec --json`, T01) | Claude (`-p --output-format stream-json`, T02) |
|---|---|---|
| Transport | One-shot process, JSONL on stdout | One-shot process, JSONL on stdout — same shape of integration work for the adapter |
| Explicit cancel event | None — infer from process exit + missing `turn.completed`/`turn.failed` | None — infer from process exit + missing terminal `result` (same pattern) |
| Explicit failure signal | `turn.failed` event type itself signals failure | Terminal `result.is_error`/`terminal_reason`; **`subtype` stays `"success"` even on error** — a Claude-specific gotcha |
| MCP | Not exposed by `exec`; only `app-server` (experimental) has MCP | **Exposed directly in print mode** via `--mcp-config`/`--strict-mcp-config`, verified working end-to-end with a real scoped stdio server |
| Session resume | `exec resume`/`fork` subcommands exist per `--help`, not exercised in T01 | **Verified working**: `--session-id` + `--resume <id>` resumes conversation state across separate processes |
| Ambient config isolation | `--ephemeral` avoids persisting session files; no plugin/skill/hook inheritance surface observed in T01 | **Inherits the operator's full MCP/hook/skill/plugin configuration by default** unless explicitly isolated (§9) — not found in Codex's `exec` evidence |
| Approval/HITL granularity | All-or-nothing via `--approve-for-me`; per-action approvals only in experimental `app-server` | All-or-nothing via `--permission-mode`/`--permission-prompts`; true mid-turn pause/resume of a single process not demonstrated here either |
| Bun subprocess fit | Not evaluated in T01 (Codex evidence did not test Bun specifically) | **Confirmed**: `Bun.spawn` + stream line-splitting works cleanly on macOS arm64 |

Net: Claude's print-mode CLI is **ahead of Codex's `exec` baseline on MCP and session resume** (both work today, without needing an experimental protocol), but **behind on cancel/fail signal clarity** (Codex's `turn.failed` is a cleaner terminal-event discriminator than Claude's `is_error` flag plus misleading `subtype`), and introduces a **new, Codex-did-not-have risk**: ambient operator configuration leaking into every managed run unless explicitly isolated.

## 13. Recommendations for TaskAside agent-adapter Claude driver

1. **Always pass `--strict-mcp-config` with an adapter-generated `--mcp-config <tmpfile>`** scoped to exactly the run's managed MCP endpoint (ARCHITECTURE.md's run-scoped MCP token/endpoint). Never let a managed run see the operator's personal MCP server list.
2. **Evaluate `--bare` or an isolated `CLAUDE_CONFIG_DIR`/`$HOME` for managed runs** to also strip inherited hooks, skills, plugins and CLAUDE.md auto-discovery (§9) — otherwise a project's own hooks/instructions can silently alter a managed agent's behavior and burn tens of thousands of extra cache-creation tokens per turn.
3. **Classify failure from the terminal `result` event's `is_error` and `terminal_reason` fields, never from `subtype`** — `subtype` was observed as `"success"` on a hard 404 model-not-found failure (§6). Treat non-zero exit code and `is_error:true` as the dual signal, matching the Codex approach of §6/T01 but with the Claude-specific field names.
4. **Cancellation:** send SIGTERM (adapter already does this for Codex per T01); observed termination within 1s here too. Confirm absence of a terminal `result` event before reporting `cancelled` — do not wait for a `cancelled` event type that does not exist.
5. **Session resume is a real, usable MVP primitive for Claude**: generate a UUID per run, pass `--session-id` on first turn (persistence **on**, i.e. omit `--no-session-persistence`) when the adapter needs to resume later; use `--resume <id>` from a new process for any follow-up turn (e.g., after HITL reply, after process restart). Reserve `--no-session-persistence` for genuinely one-shot, non-resumable baseline runs only (read-only inspection, disposable checks) — using it on a run that might need HITL continuation would be a design bug.
6. **Do not claim verified mid-turn process-retained HITL pause/resume.** Report this as an explicit capability gap (`hitl: unverified` or similar) until a dedicated POC with `--permission-prompts host` and a real permission-prompt tool is run — this evidence only proves cross-process session resume, not a single process holding open through a pause.
7. **MCP capability flag for `GET /capabilities`:** Claude driver can honestly report `mcp: true` (unlike Codex's `exec` baseline, which must report `mcp: false` per T01) since `--mcp-config`/`--strict-mcp-config` is verified working in print mode today.
8. **Bun integration:** `Bun.spawn` + `ReadableStream.getReader()` + manual newline-splitting is sufficient; no special flags or workarounds needed for macOS arm64 (§7).

## 14. Changed/created files

- `specs/2026-10-18-initialize-project/evidence/T02-claude-lifecycle.md` (this report)
- `specs/2026-10-18-initialize-project/evidence/fixtures/claude/events-readonly.jsonl`
- `specs/2026-10-18-initialize-project/evidence/fixtures/claude/events-write.jsonl`
- Scratch (not part of evidence, local-only): `.taskaside-implementation/scratch/run_readonly.sh`, `run_write.sh`, `run_cancel.sh`, `run_failure.sh`, `run_mcp_probe.sh`, `run_resume.sh`, `bun_claude_test.ts`, and copies of the cancel/failure/mcp-probe/resume raw JSONL logs for traceability.

Disposable repo `/tmp/taskaside-test-claude-repo` was removed after all checks completed.
