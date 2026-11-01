# TaskAside

**Local-first task queue and execution scheduler for AI coding agents.**

TaskAside lets developers queue coding tasks across registered local Git repositories, safely schedules Codex and Claude Code with atomic working-tree locking, and provides a focused web workspace for answering Human-In-The-Loop (HITL) agent questions.

---

## Key Features

- **Local-First & Private:** Everything runs locally on your machine with SQLite persistence (`bun:sqlite`). No external cloud brokers or telemetry required.
- **Single-Writer Safety:** Exactly one active writer process per canonical working tree at any time. Independent repositories execute concurrently in parallel.
- **Worker Pool Management:** Global 8-slot execution pool with priority ordering (`P0` Critical, `P1` High, `P2` Normal, `P3` Low).
- **Safety Sandbox (Root Workspace):** Configure a Root Workspace boundary in Settings to restrict agents and repositories to working strictly within that directory, safeguarding the rest of your machine.
- **Full App Shell & Web Workspace:**
  - **Landing (`/`):** Hero page introducing TaskAside.
  - **Dashboard (`/app`):** Real-time task statistics (Todo, Processing, HITL, Done, Error, Cancelled) and registered repositories.
  - **Workspace (`/app/workspace`):**
    - Task sidebar with two-level nested groupings: `State → Priority`, `Priority → State`, and `Repository → State`.
    - Colorful priority badges with distinct color indicators: **P0 (Red)**, **P1 (Orange)**, **P2 (Yellow)**, **P3 (Blue)**.
    - Global Command Palette (`⌘K` / `Ctrl+K`) with instant search and keyboard navigation.
    - Real-time conversation stream (SSE) with Markdown rendering and input composer for HITL questions.
- **Model Context Protocol (MCP):** Built-in MCP server (`http://127.0.0.1:3000/mcp`) with 7 tools, allowing Claude Code, Codex, Antigravity (Agy), Cursor, and other tools to delegate tasks programmatically.

---

## Architecture Overview

TaskAside is split into 3 independent service processes managed by a persistent supervisor:

| Component | Responsibility | Boundary Rule |
|---|---|---|
| `backend` (`:3000`) | SQLite persistence, REST API, SSE streaming, MCP server. | Exclusive owner of SQLite database. Does not spawn agent processes. |
| `execution-engine` (`:3001`) | Priority scheduler, single-writer working-tree locking, instruction builder. | Dispatches runs and coordinates reconciliation via authenticated APIs. |
| `agent-adapter` (`:3002`) | Codex & Claude driver subprocesses, event streaming, run logs. | Executes provider CLI tools inside validated repo working directories. |
| `supervisor` | Starts, monitors, and stops the 3 service processes. | Restarts crashed processes and handles graceful shutdown. |

---

## Prerequisites

- [Bun](https://bun.sh/) 1.4+
- [Git](https://git-scm.com/) 2.30+
- (Optional) [Codex CLI](https://github.com/openai/codex) or [Claude Code](https://claude.ai/code) installed locally for live agent execution.

---

## Getting Started

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/anthony-lewis/task-aside.git
cd task-aside
bun install
```

### 2. Build Services and Web UI

Compile the React/Vite frontend and package backend services:

```bash
bun run build
```

### 3. Start TaskAside

Start all three services and the supervisor:

```bash
bun run start
```

Once running:
- Open your browser at **`http://localhost:3000`** to access the web application.
- Direct routes:
  - Landing: `http://localhost:3000/`
  - Dashboard: `http://localhost:3000/app`
  - Workspace: `http://localhost:3000/app/workspace`

### 4. Service Management Commands

```bash
# Check service health and running process status
bun run status

# Stop all services gracefully
bun run stop
```

### 5. Running in Development Mode

To run individual services or watch the frontend during development:

```bash
# Terminal 1: Backend service (API, DB, MCP, SSE)
bun run src/cmd/backend.ts

# Terminal 2: Execution Engine
bun run src/cmd/execution-engine.ts

# Terminal 3: Agent Adapter
bun run src/cmd/agent-adapter.ts

# Terminal 4: Frontend Vite dev server (with HMR)
bun run dev
```

---

## Safety: Setting the Root Workspace Sandbox

To protect your system from unintended file edits outside your active projects:

1. Click on the user avatar pill in the top-right header and select **Settings**.
2. Locate the **Root Workspace Directory (Safety Sandbox)** field.
3. Enter your dedicated project workspace path (for example, `/Users/username/workspace`).
4. Click **Save Execution Settings**.

**Protection effect:**
- TaskAside will reject any attempt to register a repository located outside this folder.
- Agents receive strict containment instructions barring any operations outside this path.

---

## Connecting External Agents via MCP

TaskAside exposes a standard Model Context Protocol (MCP) endpoint at:
```
http://127.0.0.1:3000/mcp
```

### External Client Authentication & Pairing Flow

External agents connecting for the first time will receive a `401 Unauthorized` with a pairing code:

1. Connect to `http://127.0.0.1:3000/mcp` from your client.
2. Note the generated pairing code (e.g. `PAIR-ABCD12`).
3. Approve the pairing code via API or through the TaskAside Settings modal:
   ```bash
   curl -X POST http://127.0.0.1:3000/api/mcp/approve-pairing \
     -H "Content-Type: application/json" \
     -d '{
       "pairingCode": "PAIR-ABCD12",
       "clientName": "my-agent",
       "allowedTools": ["list_tasks", "get_task", "create_task", "get_messages", "post_message"]
     }'
   ```
4. Save the returned `mcp-e-...` token and pass it in the `Authorization: Bearer <TOKEN>` header.

---

### Configuration Guides

#### 1. Claude Code CLI
Add TaskAside as an HTTP MCP server:
```bash
claude mcp add taskaside http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <YOUR_MCP_TOKEN>"
```

#### 2. Claude Desktop
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "taskaside": {
      "command": "bunx",
      "args": ["taskaside", "mcp-proxy"],
      "env": {
        "TASKASIDE_URL": "http://127.0.0.1:3000/mcp",
        "TASKASIDE_TOKEN": "<YOUR_MCP_TOKEN>"
      }
    }
  }
}
```

#### 3. Antigravity (Agy)
Add to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "taskaside": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_MCP_TOKEN>"
      }
    }
  }
}
```

#### 4. Cursor IDE
Open **Cursor Settings → MCP**, click **Add New MCP Server**:
- **Name:** `taskaside`
- **Type:** `sse` or `http`
- **URL:** `http://127.0.0.1:3000/mcp`
- **Headers:** `{"Authorization": "Bearer <YOUR_MCP_TOKEN>"}`

---

## Ready-to-Use Agent Skill (`skills/taskaside`)

This repository includes a ready-to-use agent skill located in [`skills/taskaside/`](./skills/taskaside/).

### Installation

Copy the skill folder to your agent's skills directory:

```bash
# For Antigravity (Agy):
cp -r skills/taskaside ~/.gemini/antigravity-cli/skills/

# For Claude Code:
cp -r skills/taskaside ~/.claude/skills/
```

### Available MCP Tools in the Skill

- `list_tasks(status?, limit?, offset?)`: View tasks in the queue.
- `get_task(taskId)`: Get full task status, logs, and metadata.
- `create_task(title, description, priority, repoId, idempotencyKey)`: Queue a coding task for Codex or Claude.
- `get_messages(taskId)`: Retrieve conversation and review agent steps.
- `post_message(taskId, content, inReplyToRequestId?)`: Send follow-up messages or answers to HITL questions.
- `request_input(taskId, question)`: Ask the user a question.
- `yield_task(taskId)`: Yield execution lock while waiting for human input.

### Quick CLI Fallback (`mcp-delegate.ts`)

You can also delegate tasks directly from your shell without configuring an MCP client:

```bash
# List tasks
bun run skills/taskaside/scripts/mcp-delegate.ts list

# Create a task
bun run skills/taskaside/scripts/mcp-delegate.ts create \
  --title "Implement OAuth2 login flow" \
  --repo "repo-id-here" \
  --priority "P0" \
  --desc "Follow specs in docs/auth.md"

# Inspect task details
bun run skills/taskaside/scripts/mcp-delegate.ts get --id "<task-id>"

# Reply to an agent question
bun run skills/taskaside/scripts/mcp-delegate.ts reply --id "<task-id>" --msg "Use RS256 algorithm"
```

---

## Running Verification & Tests

TaskAside includes a deterministic test suite covering database contracts, API endpoints, process lifecycles, and UI state:

```bash
# Run all deterministic test checks
bun run check:deterministic

# Run individual test suites
bun run test:contracts    # Contracts and boundaries
bun run test:db           # SQLite schema, migrations, WAL mode
bun run test:api          # REST endpoints & path canonicalization
bun run test:mcp          # MCP tools, scopes & pairing flow
bun run test:engine       # Scheduler & execution engine
bun run test:adapter      # Codex & Claude driver adapters
```

---

## License

MIT
