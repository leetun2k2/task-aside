# IR-05 Evidence: Enforced Provider Profiles

## 1. Summary of Changes
- **Claude Intake Profile (`src/agent-adapter/drivers/claude.ts`)**:
  - Configured with `--tools ""` (disabling all built-in Bash/Edit/Read tools).
  - Configured with `--bare` (disabling hooks, auto-memory, and ambient discovery).
  - Enforces `--strict-mcp-config` with only the managed taskaside MCP server.
- **Codex Intake Profile (`src/agent-adapter/drivers/codex.ts`)**:
  - Configured with `--sandbox read-only` (preventing command modification).
  - Configured with `--skip-git-repo-check` (enabling execution in scratch directory).
  - Enforces `--ignore-user-config` and scoped managed MCP config.
- **Profile Validation & Rejection (`src/agent-adapter/manager.ts`)**:
  - Unsupported Intake profiles (e.g., `agy` provider for intake) are rejected before spawn with `VALIDATION_ERROR`.
  - Codex session resume is rejected before spawn with `VALIDATION_ERROR`.

## 2. Executed Checks
- `bun run test:claude`: PASS (12/12 checks passed)
  - Proved print mode, strict MCP, and session resume arguments.
  - Proved real CLI start, stream, terminal failure handling, and cancel stop verification.
- `bun run test:codex`: PASS (8/8 checks passed)
  - Proved read-only sandbox, scoped MCP, and flags safety.
  - Proved real CLI exec start, JSON stream mapping, and cancel stop verification.
- `bun run test:adapter`: PASS (14/14 checks passed)
  - Proved capabilities reporting, profile validation, and rejection of invalid profiles.

## 3. Result
- Status: **PASS**
- Profiles enforced before spawn; tools disabled for Intake; unsupported profiles fail early.
