---
name: taskaside
description: >-
  Delegate tasks to TaskAside (local-first autonomous coding task queue) via MCP or HTTP REST curl.
  Use when delegating coding tasks, queuing work for Claude, Codex, or Agy in local repositories,
  checking background task progress, or answering human-in-the-loop (HITL) agent questions.
---

# TaskAside Skill

This skill enables AI coding agents (Claude, Codex, Antigravity/Agy, Cursor, etc.) to delegate coding work to **TaskAside** via its Model Context Protocol (MCP) server or generic `curl` HTTP calls.

TaskAside handles queueing, concurrency limits, single-writer working-tree locking, and execution safety within your designated local Git repositories.

---

## 1. Quick Setup & Installation

Copy this skill folder into your agent's skill directory:

- **Antigravity (Agy)**:
  ```bash
  cp -r skills/taskaside ~/.gemini/antigravity-cli/skills/
  ```
- **Claude Code**:
  ```bash
  cp -r skills/taskaside ~/.claude/skills/
  ```
- **Cursor / OpenCode / Other agents**:
  Copy to your agent's active skills or rules directory.

---

## 2. MCP Server Configuration

Ensure TaskAside is running on your machine:

```bash
# In the TaskAside repository:
bun run start
# Server listens on http://127.0.0.1:3000
```

Add TaskAside to your agent's MCP configuration:

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "taskaside": {
      "command": "bunx",
      "args": ["taskaside", "mcp-proxy"],
      "env": {
        "TASKASIDE_URL": "http://127.0.0.1:3000/mcp",
        "TASKASIDE_TOKEN": "<YOUR_EXTERNAL_MCP_TOKEN>"
      }
    }
  }
}
```

### Antigravity (`~/.gemini/config/mcp_config.json`)
```json
{
  "mcpServers": {
    "taskaside": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_EXTERNAL_MCP_TOKEN>"
      }
    }
  }
}
```

### Pairing External Clients
When connecting an external client for the first time without a token:
1. Make a request to `http://127.0.0.1:3000/mcp` — you will receive a `401 Unauthorized` with a pairing code (e.g. `PAIR-ABCD12`).
2. Approve the pairing code in the TaskAside UI (**Avatar Menu → Settings**) or via API:
   ```bash
   curl -X POST http://127.0.0.1:3000/api/mcp/approve-pairing \
     -H "Content-Type: application/json" \
     -d '{
       "pairingCode": "PAIR-ABCD12",
       "clientName": "my-agent",
       "allowedTools": ["list_tasks", "get_task", "create_task", "get_messages", "post_message"]
     }'
   ```
3. Save the returned `mcp-e-...` token in your MCP configuration headers.

---

## 3. Available MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| `list_tasks` | `status?: string`, `limit?: number`, `offset?: number` | List tasks in the queue. Statuses: `todo`, `processing`, `hitl`, `done`, `error`, `cancelled`. |
| `get_task` | `taskId: string` | Get full task details, execution status, and error messages. |
| `create_task` | `title: string`, `description?: string`, `priority: "P0" \| "P1" \| "P2" \| "P3"`, `repoId: string`, `idempotencyKey: string` | Queue a coding task. Priority: `P0` (Critical), `P1` (High), `P2` (Normal), `P3` (Low). |
| `get_messages` | `taskId: string`, `cursor?: string`, `limit?: number` | Retrieve conversation history and agent logs for a task. |
| `post_message` | `taskId: string`, `content: string`, `inReplyToRequestId?: string` | Post a follow-up instruction or answer a pending HITL question. |
| `request_input` | `taskId: string`, `question: string` | Ask the human user a clarifying question (transitions task to `hitl`). |
| `yield_task` | `taskId: string`, `reason?: string` | Pause task execution pending external work or input. |

---

## 4. How to Delegate a Task via MCP

### Step 1: List registered repositories
Call `list_tasks` or inspect known repositories to obtain the `repoId`:
```json
{
  "name": "list_tasks",
  "arguments": {
    "limit": 10
  }
}
```

### Step 2: Create a task
Generate a unique `idempotencyKey` and delegate the task:
```json
{
  "name": "create_task",
  "arguments": {
    "title": "Refactor auth middleware to use JWT verification",
    "description": "Please update src/auth.ts to verify RS256 JWT tokens. Run test suite before finishing.",
    "priority": "P1",
    "repoId": "repo-uuid-or-id",
    "idempotencyKey": "jwt-refactor-2026-10-25-01"
  }
}
```

### Step 3: Monitor task progress
Check task status periodically:
```json
{
  "name": "get_task",
  "arguments": {
    "taskId": "task-uuid"
  }
}
```

### Step 4: Answer HITL Questions
If `task.status === "hitl"`, retrieve the agent's pending question using `get_messages`, then reply:
```json
{
  "name": "post_message",
  "arguments": {
    "taskId": "task-uuid",
    "content": "Use the RS256 algorithm with public key from env variable JWT_PUBLIC_KEY.",
    "inReplyToRequestId": "req-uuid"
  }
}
```

---

## 5. Generic curl Calling Guide (Direct HTTP REST)

When calling TaskAside directly via shell or non-MCP workflows, use generic `curl` commands parameterized with environment variables prefixed by `TASKASIDE_`.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `TASKASIDE_BASE_URL` | TaskAside server base URL | `http://127.0.0.1:3000` |
| `TASKASIDE_TOKEN` | Bearer authorization token (if auth is enabled) | _(optional)_ |
| `TASKASIDE_REPO_ID` | Target registered repository ID | _(required for task creation)_ |
| `TASKASIDE_TITLE` | Task title | _(required for task creation)_ |
| `TASKASIDE_DESCRIPTION` | Task instruction/specification for the agent | `""` |
| `TASKASIDE_PRIORITY` | Task priority (`P0`, `P1`, `P2`, `P3`) | `P2` |
| `TASKASIDE_PARENT_ID` | Optional parent task ID for subtasks | `null` |
| `TASKASIDE_TASK_ID` | Task ID to inspect, update, or post message to | _(required for get/post)_ |
| `TASKASIDE_MESSAGE` | Human reply message or answer to HITL question | _(required for message post)_ |
| `TASKASIDE_STATUS` | Status filter (`todo`, `processing`, `hitl`, `done`, `error`, `cancelled`) | _(optional)_ |
| `TASKASIDE_LIMIT` | Pagination limit | `20` |

### 5.1. List Repositories
```bash
curl -s -X GET "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/api/repositories" \
  ${TASKASIDE_TOKEN:+-H "Authorization: Bearer $TASKASIDE_TOKEN"}
```

### 5.2. Create a New Task
```bash
curl -s -X POST "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/api/tasks" \
  -H "Content-Type: application/json" \
  ${TASKASIDE_TOKEN:+-H "Authorization: Bearer $TASKASIDE_TOKEN"} \
  -d "{
    \"title\": \"${TASKASIDE_TITLE}\",
    \"description\": \"${TASKASIDE_DESCRIPTION}\",
    \"priority\": \"${TASKASIDE_PRIORITY:-P2}\",
    \"repoId\": \"${TASKASIDE_REPO_ID}\"${TASKASIDE_PARENT_ID:+, \"parentId\": \"$TASKASIDE_PARENT_ID\"}
  }"
```

### 5.3. List Tasks
```bash
curl -s -X GET "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/api/tasks?limit=${TASKASIDE_LIMIT:-20}${TASKASIDE_STATUS:+&status=$TASKASIDE_STATUS}" \
  ${TASKASIDE_TOKEN:+-H "Authorization: Bearer $TASKASIDE_TOKEN"}
```

### 5.4. Get Task Details
```bash
curl -s -X GET "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/api/tasks/${TASKASIDE_TASK_ID}" \
  ${TASKASIDE_TOKEN:+-H "Authorization: Bearer $TASKASIDE_TOKEN"}
```

### 5.5. Get Task Conversation / Agent Logs
```bash
curl -s -X GET "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/api/tasks/${TASKASIDE_TASK_ID}/messages?limit=${TASKASIDE_LIMIT:-50}" \
  ${TASKASIDE_TOKEN:+-H "Authorization: Bearer $TASKASIDE_TOKEN"}
```

### 5.6. Answer HITL Question / Post Instruction to Task
```bash
curl -s -X POST "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/api/tasks/${TASKASIDE_TASK_ID}/messages" \
  -H "Content-Type: application/json" \
  ${TASKASIDE_TOKEN:+-H "Authorization: Bearer $TASKASIDE_TOKEN"} \
  -d "{
    \"role\": \"user\",
    \"content\": \"${TASKASIDE_MESSAGE}\"
  }"
```

### 5.7. Cancel Task
```bash
curl -s -X POST "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/api/tasks/${TASKASIDE_TASK_ID}/cancel" \
  ${TASKASIDE_TOKEN:+-H "Authorization: Bearer $TASKASIDE_TOKEN"}
```

### 5.8. Call MCP JSON-RPC via curl
```bash
curl -s -X POST "${TASKASIDE_BASE_URL:-http://127.0.0.1:3000}/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TASKASIDE_TOKEN}" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "list_tasks",
      "arguments": { "limit": 10 }
    }
  }'
```
