# Run review: implementation task cards

Read the [execution tracker](00-execution-plan.md) and [behavior specification](../2026-10-24-run-review-plan.md) first. Dependencies, readiness, and status live in the tracker. All checks below are planned, not results already obtained.

Each card has one reviewable outcome. Internal filenames/functions remain implementer choices. Do not write unit tests, use screenshots, alter task-state authority, or upload capture data.

## RR-01 — Record baseline and artifact contract

- **Deliver:** Inspect current claim, context, instruction, start, provider stream, finalization, and CLI paths. Record the archive v1 contract: stable run identity, service-instance segments, artifact writers, event provenance, completeness, usage scopes, and review fields. Define required artifacts for pre-launch versus launched runs; a never-launched provider is `not_started`, not missing terminal output.
- **Limit:** Documentation and safe baseline evidence only. Reuse the earlier spec; settle remaining choices without a generic telemetry framework. Separate schema version, app version, prompt template/flow version, task input digest, and rendered prompt digest. Hash redacted data for correlation; do not retain secret originals or hash low-entropy credentials.
- **Verify:** Record safe existing check commands and distinguish fake/fixture/live sections. Include one small sanitized success and interrupted-run example that downstream tasks can use. No application code or provider execution is required to finish this card.

## RR-02 — Close secret logging paths

- **Deliver:** Route existing launch and stderr logging through sanitization. Save safe launch settings instead of serializing complete arguments, MCP authorization, or the environment. Keep validated numeric usage counters readable even when their names contain `token`.
- **Limit:** Preserve executable/argument arrays, auth, permission behavior, prompts sent to providers, and current run events. The logging change must not change the provider invocation. Do not scan or rewrite the user's existing log archive.
- **Verify:** Fake subprocess integration injects secrets into prompt, nested MCP data, stdout/tool text, and stderr, including split chunks. No fixture credential reaches new files or diagnostics. Unknown/malformed content is bounded and sanitized or omitted; no unsafe fallback writes it raw.

## RR-03 — Add bounded archive storage

- **Deliver:** Create `<dataDir>/run-reviews/<runId>/` with immutable identity and distinct engine/adapter writer segments. Support create-once identity, append-only JSONL, atomic snapshots, capture coverage, periodic/terminal flush, restrictive permissions, and bounded asynchronous writes. Reserve space for metadata and enforce per-run/total byte bounds across concurrent processes.
- **Limit:** Reuse existing app-data resolution and its override. Validate IDs and prevent traversal/symlink escape. No SQLite, new service, shared mutable status file, unbounded queue, or generic storage abstraction. Before RR-09 cleanup exists, exhausted capacity must stop verbose capture and warn rather than grow past quota.
- **Verify:** Two processes, duplicate initialization, changed identity, stale writer segments, bad IDs, huge records, interrupted JSONL, full/unwritable disk, and snapshot failure preserve prior records and limits. Secret-bearing content passes RR-02 before disk. Logging errors do not throw into process supervision or release task locks.

## RR-04 — Capture engine input and lifecycle

- **Deliver:** Create the run record as soon as durable admission is known, before context fetching or dispatch can fail. Save the actual task/context selection and redacted assembled instruction, omission metadata, flow version, dispatch attempts, backend ACKs, reconnect/reconcile, HITL, timeout/cancel/yield, and observed finalization results.
- **Limit:** Capture every existing admitted-run entry path, including recovered admissions and supported continuations. Missing start/context data stays explicitly partial. No provider spawn, SQLite access, new API, scheduling change, injected tool result, or state transition based on a file. A lost admission ACK can only be linked after existing reconciliation discovers the run.
- **Verify:** Through engine/service integration, fail context fetch after claim, fail adapter start, drop an ACK, restart monitoring, and continue a supported HITL run. Records retain the same run/generation, never overwrite the first prompt, and never call an unacknowledged backend transition committed.

## RR-05 — Capture adapter lifecycle and output

- **Deliver:** Save provider/runtime identity, safe settings, normalized events, sanitized stderr, final-answer evidence, and per-segment closure/completeness. Track requested versus reported model separately. Capture starts at accepted start and closes on actual process-stream closure or records interruption.
- **Limit:** This adds recording beside current behavior, not new resume support or new stop proof. A terminal provider event does not close the archive before trailing usage/streams are consumed. Keep message history when a final answer cannot be identified; mark final output unavailable rather than promote arbitrary progress text.
- **Verify:** Fake executable success, nonzero exit, spawn failure, missing executable, terminal-before-close, cancel/timeout races, duplicate start, malformed stream, and no trailing newline have accurate records. A detached child's uncertain state remains uncertain; capture cannot fabricate verified termination.

## RR-06 — Capture Codex trace and usage

- **Deliver:** Preserve sanitized emitted command/tool/file/plan/reasoning-summary events before the current lossy mapping. Record provider source IDs, turn/session linkage, message order, timestamps, and available usage counters. Retain unknown event types as bounded sanitized evidence with coverage labels.
- **Limit:** Keep the existing Codex exec protocol, CLI flags, normalized chat events, and capabilities. Do not infer hidden reasoning, missing counters, or resume support. Pin fixture interpretation to the recorded CLI version; current installed-version verification belongs to RR-16.
- **Verify:** Stream existing sanitized fixtures through a fake executable into the adapter, not only a pure parser. Command output, final message, terminal usage, unknown events, duplicate records, and a split final line reach the archive with stable provenance and no altered backend event sequence.

## RR-07 — Capture Claude trace and usage

- **Deliver:** Preserve sanitized assistant text, exposed thinking, tool-use/result linkage, errors, and terminal usage/cost estimates. Record message/session IDs and terminal classification fields. Empty thinking and omitted opaque signatures have explicit coverage markers.
- **Limit:** Keep the current CLI driver, permissions, MCP handling, and resume capability contract. Do not infer success from terminal subtype alone or treat every assistant block as a new token charge. Installed-version verification belongs to RR-17.
- **Verify:** Fake executable fixtures include repeated message IDs, parallel tool blocks, result aggregates, API error with success subtype, cancellation before result, unknown content, and split lines. Tool results remain linked; failure and missing usage remain visible without chat pollution.

## RR-08 — Reconcile usage across records

- **Deliver:** Produce `usage.json` with observed provider counters, source identities, scope, normalized values where verified, and complete/partial/unavailable coverage. Deduplicate repeated records, reconcile finalized message updates, and avoid adding overlapping message/turn/session aggregates. Link retries and parent/child runs for explicitly selected rollups.
- **Limit:** Cache/reasoning subsets are not extra total tokens. Preserve provider semantics when normalization is unknown. Session totals require a comparable prior baseline before attribution to one run. Provider-managed subagent coverage is included/excluded/unknown explicitly. Cost remains an estimate; no pricing service, character-based token guess, or billing/quota claim.
- **Verify:** End-to-end fixture archives reconcile with known expected counters for duplicates, final updates, multiple turns, resumed sessions, resets, failures, and absent terminal data. A task-family total lists included run IDs, includes failed/retried spend, and flags missing coverage instead of counting it as zero.

## RR-09 — Add retention and pin protection

- **Deliver:** Apply age/quota cleanup to eligible terminal archives; preserve explicitly pinned, active, uncertain, and unknown records. Record deletion policy, dropped capture, and saturation warnings. Provide a documented local pin/unpin mechanism without a new UI or API.
- **Limit:** Only operate inside the validated archive root. A stale terminal-looking file or dead writer alone is insufficient proof of cleanup eligibility. Require consistent terminal backend observation and closed expected segments; ambiguity stays protected. No task cancellation, lock release, or provider stop as a storage shortcut.
- **Verify:** Race cleanup with capture, report generation, pin/unpin, restart, and two cleanup attempts. Protected records survive; byte accounting includes derived reports and writer segments. If protected data exhausts the budget, verbose capture stops with bounded warnings and existing data remains intact. Use a controlled clock for age checks.

## RR-10 — Capture bounded Git evidence

- **Deliver:** Assess and, where safe, capture read-only before/after Git metadata, dirty/untracked baseline, changed paths, and a bounded patch. Link evidence to the relevant run segment and state what can be attributed to it.
- **Limit:** No commit, reset, repo snapshot, worktree manager, or blanket copying of ignored/binary files. Bound time/output; avoid optional Git index writes and unsafe repository hooks/helpers. Do not read mutable repo contents after ownership is lost or a successor writer starts; mark the later snapshot unavailable instead.
- **Verify:** Disposable repos cover existing staged/unstaged changes, untracked/ignored/binary files, changed HEAD, timeouts, lost ownership, and successor activity. Existing files and index remain unchanged by capture. If attribution is unsafe, report `unavailable` or `uncertain`; RR-11 must still produce a useful report.

## RR-11 — Add local report command

- **Deliver:** Implement `taskaside runs report <runId>` through the CLI and installed launcher/help. Derive `summary.md` from archive records: requested goal, actual output, changes, checks observed versus claimed, usage, interventions, provider outcome, last observed backend outcome/time, and capture gaps. Include a create-if-absent review template for RR-12.
- **Limit:** Read files only; no supervisor start, browser open, auth bootstrap, live backend query, SQLite, provider call, or recorded command execution. Backend observations are historical, not live state. Support partial folders and legacy `.log` discovery with explicit missing fields; do not pretend to reconstruct lost data. Preserve unsupported versions with a clear error.
- **Verify:** Invoke CLI and launcher against isolated complete, partial, active, corrupt, unknown-version, and legacy records while services are stopped. A generated partial report identifies gaps. Invalid IDs/unreadable inputs fail clearly without starting services. No unsanitized record payload is printed as an error. Derived writes respect quota.

## RR-12 — Add human verdict and review template

- **Deliver:** Finalize validated `review.json` fields for correctness, scope, verification, efficiency notes, intervention, verdict, reviewer/time, evidence links, root cause, and one proposed change. Default verdict is `unreviewed`. Explain the manual edit/report workflow and pinning.
- **Limit:** No LLM grader, inferred human acceptance, UI form, or automatic flow rewrite. Regeneration never overwrites the user's verdict or notes; invalid review input is reported separately from execution status. Review text is data, never executable instructions.
- **Verify:** Create/edit/regenerate a review for complete and partial runs. Human edits survive; absent evidence remains unverified. Review links resolve within the run evidence, and a person can identify outcome, missing proof, and one useful next change within two minutes.

## RR-13 — Add matched flow comparison

- **Deliver:** Define small dataset manifests and implement `taskaside runs compare <baselineDir> <candidateDir>`. Start with 5–10 representative case definitions and a tiny sanitized archive sample. Match by logical case, task input, repo baseline, provider/model/config; identify changed flow/template version separately. Compare reviewed acceptance, verification, interventions, duration, and tokens per accepted task, including failed/retried spend.
- **Limit:** Keep task-input digest distinct from rendered-prompt digest so an intended prompt change does not invalidate the task match. Missing/incompatible cases are listed and excluded from paired claims, never silently dropped. Print Markdown by default; input directories remain read-only. No automatic execution or claim that synthetic fixtures prove a better coding flow.
- **Verify:** CLI/launcher integration covers reordered cases, retries, parent/child membership, incomplete usage, missing verdict, mismatched models/baselines, and no matched cases. Counts, coverage, denominators, and exclusions are explicit. A lower-token but incorrect candidate cannot be reported as an improvement.

## RR-14 — Verify runtime failure and overhead

- **Deliver:** Complete deterministic integration/process qualification of the whole capture path. Measure the same fake workload with and without capture, including eight concurrent independent runs and a waiting ninth. Record event-ingestion/control latency, CPU/RSS, queue bounds, flush time, archive bytes, and report generation cost.
- **Limit:** Preserve pool/fencing/stop invariants and existing latency gates. Test-only shortened deadlines/clock control may avoid long waits; production timeouts stay unchanged. Do not run real providers in this gate. Fix only reproduced capture defects; unrelated baseline failures remain separately reported.
- **Verify:** Inject duplicate events, reconnects, crashes, stale writers, timeout/yield/cancel races, full/unwritable disk, huge/split secret output, malformed/trailing records, and retention races. No mixed runs, unbounded growth, raw secret fallback, duplicate usage, or log-driven respawn/release. Explain any measurable overhead and resolve capture-caused violations of existing control budgets.

## RR-15 — Verify installed macOS commands

- **Deliver:** Build/pack and exercise the installed payload in a disposable app-data path. Prove automatic capture through actual service startup and offline `runs report` / `runs compare` through the Node launcher. Verify both source and installed help/exit behavior.
- **Limit:** No npm publication, live install replacement, user repo access, real provider calls, or dependence on the source checkout/ephemeral package cache. Do not change package installation policy beyond what these commands require.
- **Verify:** With fake providers, run task → records → stop services → report → verdict → compare from an unrelated cwd. Check paths with spaces, override resolution, quota, legacy logs, static-file isolation, payload rebuild/version handling, and compatible rollback preserving records. Failed commands do not open a browser or start services.

## RR-16 — Verify live Codex capture

- **Deliver:** Use the installed existing Codex integration in a disposable registered repo for completion, failure, and cancellation capture. Record installed CLI/runtime versions and compare actual emitted events/usage with the archive/report. Refresh sanitized fixtures only where current evidence differs.
- **Limit:** Existing login/config only; no new API integration, credential changes, user repo edits, privileged auto-approval, or unsupported resume claims. Follow current official provider docs and local harness guidance before execution. Missing executable/auth/network is a blocked provider gate, not a pass.
- **Verify:** Input, public explanations/tools, final-output availability, counters/scope, cancellation gaps, and stop/close evidence are truthful. Perform one human review through RR-12. State which fields were unavailable and whether historical fixtures still match. Do not infer invoice or complete hidden reasoning from observed data.

## RR-17 — Verify live Claude capture

- **Deliver:** Independently exercise completion, failure, and cancellation through the installed Claude driver with disposable data/repos. Check repeated message usage, terminal scope, cost estimate, and supported continuation only where actually available.
- **Limit:** Keep the chosen CLI protocol and existing login. No SDK switch, credential setup, user repo edits, or new permission approval path. Missing provider access blocks this gate without invalidating completed deterministic work.
- **Verify:** Match actual stream counters to archive totals without block/result double counting. Confirm how resumed totals behave before run attribution; otherwise report scope unavailable. Perform one human review and record exact CLI versions, observed limitations, and secrets-free evidence separately from Codex.

## RR-18 — Verify Linux and Windows records

- **Deliver:** On actual target OSes, verify app-data paths, permissions, multi-process bounded writes, atomic snapshots, partial recovery, quota/retention, and installed offline report/compare commands. Capture provider-specific evidence only for combinations actually exercised.
- **Limit:** Platform mocks, cross-compilation, and macOS evidence do not prove target support. No paid infrastructure provisioning, relaxed permissions, or skipped assertions presented as passing. Split target-specific repairs into child tasks if needed.
- **Verify:** Record target OS/architecture/runtime and executed scenarios. Missing access leaves that target blocked with a next action; complete evidence from the other target remains valid. Protect data and live installs exactly as on macOS.

## RR-19 — Close docs and evidence handoff

- **Deliver:** Update CLI/README and architecture/storage docs with actual implemented behavior and supported versions. Save a concise local report mapping RR-01–18 to evidence, archive/command examples, configuration, pin/retention policy, secret handling, performance results, migration/rollback, provider limits, and open OS gates.
- **Limit:** Do not modify unrelated refactor statuses, commit/push/publish, add secret-bearing provider transcripts to Git, or claim that implemented comparison already improved coding quality. Use fake examples in documentation. Preserve the distinction between execution outcome, capture coverage, and human verdict.
- **Verify:** Relevant checks pass after final code changes, documentation links resolve, installed commands match docs, statuses match evidence, and the minimal UI remains intact. An interim report is allowed while access gates are blocked; mark this task fully done only after the required final gates close.
