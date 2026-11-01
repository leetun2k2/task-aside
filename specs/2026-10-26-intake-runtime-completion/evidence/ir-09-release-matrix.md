# IR-09 Evidence: Release Matrix, Package Proof & Operational Boundaries

## 1. Environment & Package Verification
- **Host OS**: macOS (Darwin 25.3.0 arm64)
- **Runtime**: Bun 1.4.3
- **Package verification (`bun run test:distribution`)**:
  - `dist/` compilation verified for frontend assets and all 4 service entry points (`backend.js`, `agent-adapter.js`, `execution-engine.js`, `cli.js`).
  - `npm pack --dry-run` confirms package files restricted to `bin/` and `dist/`.
  - Supervisor detachment and clean service termination verified.
- **Cross-OS checks (`bun run test:cross-os`)**:
  - macOS platform checks pass.
  - Linux and Windows are explicitly recorded as deferred release gates pending live execution environments.

## 2. Provider Capability & Operational Support Matrix

| Provider | Profile / Route | Support Status | Notes |
|---|---|---|---|
| **Claude** (`claude 2.1.267`) | Intake Profile | **Supported & Enforced** | Runs with `--tools ""` and `--bare` with scoped `--mcp-config`. |
| **Claude** (`claude 2.1.267`) | Single-Repo Implementation | **Supported & Enforced** | Print-mode execution, verified stop proof, session resume supported. |
| **Claude** (`claude 2.1.267`) | Multi-Repo Implementation | **Blocked** | `--add-dir` mapping implemented in driver; multi-root write authorization gate blocked pending live permission evidence. |
| **Codex** (`codex-cli 0.164.0`) | Intake Profile | **Supported & Enforced** | Runs with `--sandbox read-only` and `--skip-git-repo-check`. |
| **Codex** (`codex-cli 0.164.0`) | Single-Repo Implementation | **Supported & Enforced** | `exec` mode, verified stop proof. Session resume disabled. |
| **Codex** (`codex-cli 0.164.0`) | Multi-Repo Implementation | **Blocked** | `--add-dir` mapping implemented in driver; multi-root write authorization gate blocked pending live permission evidence. |
| **Agy** | Intake Profile | **Disabled / Blocked** | Rejects with `VALIDATION_ERROR` before spawn (does not support tool isolation). |
| **Agy** | Multi-Repo Implementation | **Disabled / Blocked** | Rejects before spawn (lacks multi-root directory flags). |

## 3. Route & Operating System Status
- **macOS**: Supported for single-repo Claude and Codex execution.
- **Linux / Windows**: Explicitly deferred / unverified until native runners are validated.
- **Multi-Repo Live Dispatch**: Intentionally blocked per specification until upstream CLI multi-root write safety is verified.
