# Evidence: LC-01a — Inventory commands and safe environments

## Outcome
Inventory completed for all repository commands, scripts, checks, launchers, CI workflows, and cleanup mechanisms. All commands are classified by environment type, isolation strategy, runtime prerequisites, and safety guarantees.

## Affected Owners / Files
- `package.json`
- `.github/workflows/ci.yml`
- `bin/taskaside.js`
- `specs/2026-10-25-layered-code-organization/01-execution-plan.md`
- `specs/2026-10-25-layered-code-organization/evidence/lc-01a.md`

## Runtime / Tool Versions
- OS: Darwin arm64 (macOS 15.x / Darwin Kernel Version 25.6.0)
- Bun: 1.4.3
- Node.js: v26.9.0
- Git: 2.50.1
- Codex CLI: codex-cli 0.164.0 (/opt/homebrew/bin/codex)
- Claude Code CLI: 2.1.267 (/opt/homebrew/bin/claude)
- Chrome: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome (available for CDP headless checks)

## Command Classification Matrix

| Command / Script | Classification | Environment & Isolation Strategy | Safety / Disposable Setup |
|---|---|---|---|
| `bun run typecheck` (`tsc --noEmit`) | In-process | Local TypeScript compiler, read-only | No mutations |
| `bun run lint` (`biome check .`) | In-process | Biome linter, read-only | No mutations |
| `bun run format:check` (`prettier --check .`) | In-process | Prettier format checker, read-only | No mutations |
| `bun run build:ui` (`vite build`) | In-process | Emits frontend bundle to `dist/` | Build-only |
| `bun run build:services` (`bun build ...`) | In-process | Emits service bundles to `dist/services/` | Build-only |
| `bun run build` | In-process | Composite UI + services build | Build-only |
| `bun run test:contracts` | In-process | Contract schema & cross-owner boundary check | Read-only scan & Zod schemas |
| `bun run test:db` | In-process | SQLite DB migrations, constraints, triggers | Disposable tmp SQLite DB |
| `bun run test:api` | In-process | REST & SSE API tests via in-memory Hono fetch | Disposable tmp SQLite DB & data dir |
| `bun run test:runs` | In-process | Run lifecycle, locking, and fencing | Disposable tmp SQLite DB & disposable git repo |
| `bun run test:events` | In-process | In-memory event hub and SSE projection | Disposable tmp SQLite DB |
| `bun run test:mcp` | In-process | MCP tools, auth, tokens, child task limits | Disposable tmp SQLite DB & disposable git repo |
| `bun run test:projection` | In-process | Projections and SSE events | Disposable tmp SQLite DB |
| `bun run test:services` | Fake-process | Service startup & supervisor lifecycle | Isolated ports & tmp data dir |
| `bun run test:supervisor` | Fake-process | Supervisor hardening, process crash recovery | Isolated ports & tmp data dir |
| `bun run test:harness` | Fake-process | Full integration harness with mock adapter/backend | Isolated ports & tmp data dir |
| `bun run test:adapter` | Fake-process | Adapter endpoints, process manager, fake drivers | Isolated ports & tmp data dir |
| `bun run test:safety` | Fake-process | Adapter safety bounds, arg validation, cancellation | Isolated ports & tmp data dir |
| `bun run test:engine` | Fake-process | Engine scheduler, dispatcher, reconciler | In-memory mock clients & tmp data dir |
| `bun run test:startup` | Fake-process | Engine startup reconciliation and recovery | Disposable tmp DB & mock adapter |
| `bun run test:pool` | Fake-process | Polling worker pool, 8-slot limit, single writer | Disposable tmp DB & fake adapter |
| `bun run test:ui` | In-process | Frontend UI components & API client | In-memory mock fetch / jsdom |
| `bun run test:browser` | Browser | Real headless Chrome via native CDP WebSocket | Temp DB, temp repo, no screenshot/video/trace |
| `bun run test:workflow` | In-process / Browser | Frontend workflow & event simulation | Temp DB, temp repo, mock adapter |
| `bun run test:distribution` | Fake-process | Launcher `bin/taskaside.js` payload copy & spawn | Disposable tmp data dir (`TASKASIDE_DATA_DIR`) |
| `bun run test:cross-os` | Native-OS | Evaluates macOS native environment & records gates | Disposable tmp data dir |
| `bun run test:release-candidate` | Fake-process | Deterministic checks + distribution smoke | Fully isolated temp dirs |
| `bun run test:codex` | Live-provider | Spawns real `codex` CLI with disposable repos | Isolated tmp repo, temp data dir |
| `bun run test:claude` | Live-provider | Spawns real `claude` CLI with disposable repos | Isolated tmp repo, temp data dir |
| `bin/taskaside.js` (CLI launcher) | Native-OS / Node | Resolves Bun, unpacks payload to app-data dir | Uses `TASKASIDE_DATA_DIR` if provided |

## Safe Disposable Setup Rules
1. **Never use live user install or live work repos:** Every check must allocate a fresh tmpdir via `mkdtempSync(join(tmpdir(), ...))` and set `process.env.TASKASIDE_DATA_DIR`.
2. **Never leave temp files:** All check scripts use `finally { rmSync(dir, { recursive: true, force: true }); }`.
3. **Ports:** All test servers bind to port 0 (`127.0.0.1:0`) or dynamically allocated loopback ports.
4. **Git repos:** Disposable git repos are initialized via `git init -q` in tmpdir with dummy user config (`test@taskaside.local`).
5. **Live Provider Gates:** `test:codex` and `test:claude` require local binaries and valid CLI credentials; if credentials/network are missing, the test reports failure/blocker, but deterministic checks do not invoke them.
6. **Native OS Gates:** Linux and Windows native validation cannot run on this macOS host; they are marked `blocked` when gating LC-12d/LC-12e.

## Limitations & Access Blockers
- Current host is macOS (Darwin arm64). Native Linux and Windows environments are not available on this machine.
- Codex CLI is present (`codex-cli 0.164.0`), Claude CLI is present (`2.1.267`).

## Rollback
Documentation-only task; no code changes. Rollback is deleting this evidence file.

## Next Task
LC-01b: Record backend contract baseline.
