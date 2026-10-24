# Claude implementation prompt

Paste the following into Claude Code opened in the TaskAside repository.

```text
Work in /Users/tungle/Desktop/workspace/anthony-lewis/task-aside.

Implement specs/2026-10-24-handoff-single-writer.md. Complete its Ready scope, validate the actual service workflow, and report the remaining authority/isolation blocker honestly.

Product intent: Claude/Codex/Agy planning sessions discuss and prepare approved specs, then hand work off through MCP. Only TaskAside-managed execution writes the controlled checkout. Prioritize eligible work, serialize same-checkout writers, and run independent checkouts concurrently. MCP alone cannot revoke external filesystem access; never claim it does.

Read AGENTS.md and CLAUDE.md first. Their root-level documentation links are stale: the constitution and architecture are under specs/; PRD, specification, plan, and task backlog are under specs/2026-10-18-initialize-project/. Read the relevant documents and follow the new repair spec for its explicit contract changes. Use applicable API-engineering skills if available.

This checkout contains substantial existing uncommitted/untracked work. Inspect it; preserve it. Do not reset, clean, discard, commit, push, publish, or edit unrelated repositories. Work as a single writer; do not launch parallel coding agents in this checkout.

Start by reproducing the three audited gaps: the engine entrypoint never polls/dispatches; yield trusts missing/client-supplied stop assertions and releases ownership early; external task creation cannot select the requested repo. Treat the spec's audit as evidence to verify, not permission to guess about uninspected code.

Implement the smallest complete repair:
- Safe asynchronous yield intent and trusted, fenced completion after verified process-tree exit. Preserve locks on uncertainty and survive restart.
- Normal startup drives scheduling, dispatch, heartbeat, reconciliation, cancellation, and supported HITL continuation. Prevent overlap and isolate concurrent run streams/state.
- Explicit scoped external repo selection and durable task-creation idempotency, including conflicting retries and managed child constraints.
- Accurate docs/status and a read-only planner handoff guide. Keep unresolved global authority and filesystem isolation limits visible.

Keep Bun/TypeScript, SQLite owned only by backend, three services, and the current UI/status model. No generic framework, factories, new infrastructure, new provider, or unrelated refactor. Prefer simple direct code and guard clauses.

Do not write unit tests, use screenshots, or use gitnexus. Add or extend meaningful contract/integration/process checks. Verify acceptance A1-A12 with disposable repos and isolated data. At least one check must launch the real service entrypoints and enqueue through MCP; manually calling scheduler classes does not prove the runtime works. Fake provider scenarios must measure live process overlap and stop verification, not fabricate success metadata.

Run typecheck, lint, build, and affected existing suites. Run live Codex/Claude smoke checks only against disposable repos using installed supported capabilities; if unavailable, record the specific gap without weakening guards or claiming success. Do not invent CLI flags or provider support.

Update affected contracts and docs together. Correct completion claims that exceed evidence; do not rewrite old evidence as though checks were rerun. Continue through implementation and verification without routine approval pauses. If the spec's global authority/isolation blocker remains, finish independent Ready work and report that blocker; do not invent remote hosting or OS isolation.

End with: what changed; acceptance A1-A12 results with commands/evidence; remaining risks/blockers; and whether local repair completion is justified. Include one small Mermaid diagram. Do not report the full multi-developer single-writer mission complete unless external access and authority boundaries are actually enforced and verified.
```
