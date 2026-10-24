// Implementation of the seven MCP tools (SPECIFICATION.md §4; ARCHITECTURE.md §8, §9; T14).
// Shared domain logic enforcing depth limits, child budgets, idempotency, and verified stop.
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../contracts/canonical-json.ts';
import {
  CreateTaskToolParamsSchema,
  GetMessagesParamsSchema,
  GetTaskParamsSchema,
  ListTasksParamsSchema,
  MAX_CHILDREN_PER_TASK,
  type McpToolName,
  PostMessageParamsSchema,
  RequestInputParamsSchema,
  YieldTaskParamsSchema,
  canCreateChildTask,
  isWithinChildLimit,
} from '../../contracts/mcp.ts';
import type { TaskPriority, TaskStatus } from '../../contracts/task.ts';
import { DomainError } from '../api/errors.ts';
import { appendMessage, listMessages } from '../domains/chat/messages.ts';
import { getRepositoryById } from '../domains/task/repositories.ts';
import { recordYieldIntent } from '../domains/task/runs.ts';
import {
  TASK_COLUMNS,
  type TaskRecord,
  type TaskRow,
  createTask,
  listTasks as domainListTasks,
  getTaskById,
  rowToTask,
} from '../domains/task/tasks.ts';
import { eventHub } from '../events/hub.ts';
import type { McpAuthContext } from './tokens.ts';

function hashCreateTaskPayload(payload: {
  title: string;
  description: string | null;
  priority: TaskPriority;
  repoId: string;
}): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function executeMcpTool(
  db: Database,
  authContext: McpAuthContext,
  toolName: McpToolName,
  args: Record<string, unknown> = {},
): unknown {
  if (!authContext.allowedTools.has(toolName)) {
    throw new DomainError(
      'FORBIDDEN',
      `tool '${toolName}' is not permitted by this token's scopes`,
    );
  }

  switch (toolName) {
    case 'list_tasks': {
      const parsed = ListTasksParamsSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'invalid list_tasks arguments',
          parsed.error.flatten(),
        );
      }
      return executeListTasks(db, authContext, parsed.data);
    }

    case 'get_task': {
      const parsed = GetTaskParamsSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'invalid get_task arguments',
          parsed.error.flatten(),
        );
      }
      return executeGetTask(db, authContext, parsed.data.taskId);
    }

    case 'create_task': {
      const parsed = CreateTaskToolParamsSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'invalid create_task arguments',
          parsed.error.flatten(),
        );
      }
      return executeCreateTask(db, authContext, parsed.data);
    }

    case 'get_messages': {
      const parsed = GetMessagesParamsSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'invalid get_messages arguments',
          parsed.error.flatten(),
        );
      }
      return executeGetMessages(db, authContext, parsed.data);
    }

    case 'post_message': {
      const parsed = PostMessageParamsSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'invalid post_message arguments',
          parsed.error.flatten(),
        );
      }
      return executePostMessage(db, authContext, parsed.data.content);
    }

    case 'request_input': {
      const parsed = RequestInputParamsSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'invalid request_input arguments',
          parsed.error.flatten(),
        );
      }
      return executeRequestInput(db, authContext, parsed.data.question);
    }

    case 'yield_task': {
      const parsed = YieldTaskParamsSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'invalid yield_task arguments',
          parsed.error.flatten(),
        );
      }
      return executeYieldTask(db, authContext, parsed.data);
    }

    default:
      throw new DomainError('VALIDATION_ERROR', `unknown tool: ${toolName}`);
  }
}

function executeListTasks(
  db: Database,
  authContext: McpAuthContext,
  params: { status?: string; limit?: number; offset?: number },
): TaskRecord[] {
  if (authContext.role === 'mcp-managed') {
    // Restricted to current task and its children
    const clauses: string[] = ['(id = ? OR parent_id = ?)'];
    const sqlParams: SQLQueryBindings[] = [authContext.taskId, authContext.taskId];

    if (params.status) {
      clauses.push('status = ?');
      sqlParams.push(params.status);
    }

    let sql = `SELECT ${TASK_COLUMNS} FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`;
    if (params.limit !== undefined) {
      sql += ' LIMIT ?';
      sqlParams.push(params.limit);
      if (params.offset !== undefined) {
        sql += ' OFFSET ?';
        sqlParams.push(params.offset);
      }
    }

    const rows = db.query(sql).all(...sqlParams) as TaskRow[];
    return rows.map(rowToTask);
  }

  // External caller with user-authorized scopes
  const tasks = domainListTasks(db, {
    status: params.status as TaskStatus | undefined,
  });

  return tasks.filter((t) => {
    if (authContext.allowedRepoIds && !authContext.allowedRepoIds.has(t.repoId)) {
      return false;
    }
    if (authContext.allowedTaskIds && !authContext.allowedTaskIds.has(t.id)) {
      return false;
    }
    return true;
  });
}

function executeGetTask(db: Database, authContext: McpAuthContext, taskId: string): TaskRecord {
  if (authContext.role === 'mcp-managed') {
    // Restricted to: current task, allowed parent, or its children
    const isSelf = taskId === authContext.taskId;
    const isParent = authContext.task.parentId !== null && taskId === authContext.task.parentId;

    const task = getTaskById(db, taskId);
    if (!task) {
      throw new DomainError('NOT_FOUND', `task not found: ${taskId}`);
    }

    const isChild = task.parentId === authContext.taskId;

    if (!isSelf && !isParent && !isChild) {
      throw new DomainError(
        'FORBIDDEN',
        `task ${taskId} is outside the allowed scope of this managed run`,
      );
    }

    return task;
  }

  // External
  if (authContext.allowedTaskIds && !authContext.allowedTaskIds.has(taskId)) {
    throw new DomainError('FORBIDDEN', `task ${taskId} is not in the allowed task scope`);
  }

  const task = getTaskById(db, taskId);
  if (!task) {
    throw new DomainError('NOT_FOUND', `task not found: ${taskId}`);
  }

  if (authContext.allowedRepoIds && !authContext.allowedRepoIds.has(task.repoId)) {
    throw new DomainError(
      'FORBIDDEN',
      `repository of task ${taskId} is not in the allowed repo scope`,
    );
  }

  return task;
}

function executeCreateTask(
  db: Database,
  authContext: McpAuthContext,
  params: {
    title: string;
    description?: string;
    priority?: TaskPriority;
    idempotencyKey?: string;
    repoId?: string;
  },
): TaskRecord {
  if (authContext.role === 'mcp-managed') {
    // Managed agent: parent is implicitly currentTask, repo is currentTask.repoId.
    // An explicitly different repoId is rejected — managed child tasks always
    // inherit the parent's repo (contract table: "Managed task creation").
    if (params.repoId && params.repoId !== authContext.task.repoId) {
      throw new DomainError(
        'FORBIDDEN',
        `managed child tasks must use the parent's repository (${authContext.task.repoId}); got ${params.repoId}`,
      );
    }

    if (!canCreateChildTask(authContext.task.depth)) {
      throw new DomainError(
        'CHILD_LIMIT_EXCEEDED',
        'parent task is itself a child; grandchildren are not allowed',
      );
    }

    // Check existing child count
    const childCountRow = db
      .query('SELECT COUNT(*) as count FROM tasks WHERE parent_id = ?')
      .get(authContext.taskId) as { count: number };

    if (!isWithinChildLimit(childCountRow.count)) {
      throw new DomainError(
        'CHILD_LIMIT_EXCEEDED',
        `parent task already has the maximum of ${MAX_CHILDREN_PER_TASK} children`,
      );
    }

    // Idempotency check: if origin_run_id and origin_key match an existing task, return it
    if (params.idempotencyKey) {
      const existing = db
        .query(`SELECT ${TASK_COLUMNS} FROM tasks WHERE origin_run_id = ? AND origin_key = ?`)
        .get(authContext.runId, params.idempotencyKey) as TaskRow | null;

      if (existing) {
        return rowToTask(existing);
      }
    }

    const id = randomUUID();
    const conversationId = randomUUID();
    const now = new Date().toISOString();
    const priority = params.priority ?? 'P2';

    const apply = db.transaction(() => {
      db.query('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(
        conversationId,
        now,
        now,
      );

      db.query(
        `INSERT INTO tasks
          (id, repository_id, conversation_id, parent_id, title, description, priority, status,
           agent_provider, block_kind, blocked_reason, depth, blocked_on_child_ids, origin_run_id,
           origin_key, created_at, enqueued_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, NULL, NULL, 1, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        authContext.task.repoId,
        conversationId,
        authContext.taskId,
        params.title,
        params.description ?? null,
        priority,
        authContext.run.provider ?? 'codex',
        authContext.runId,
        params.idempotencyKey ?? null,
        now,
        now,
        now,
      );
    });
    apply();

    const created = getTaskById(db, id);
    if (!created) {
      throw new DomainError('NOT_FOUND', `failed to create child task: ${id}`);
    }
    return created;
  }

  // External caller: must explicitly select a registered, authorized repo and
  // supply an idempotency key — TaskAside never picks a default repo on an
  // external caller's behalf (contract table: "External callers must supply
  // repoId and idempotencyKey. Reject missing fields; never select a default
  // repo.").
  if (!params.repoId) {
    throw new DomainError('VALIDATION_ERROR', 'repoId is required for external task creation');
  }
  if (!params.idempotencyKey) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'idempotencyKey is required for external task creation',
    );
  }

  const repository = getRepositoryById(db, params.repoId);
  if (!repository) {
    throw new DomainError('NOT_FOUND', `repository not found: ${params.repoId}`);
  }
  if (authContext.allowedRepoIds && !authContext.allowedRepoIds.has(params.repoId)) {
    throw new DomainError('FORBIDDEN', `repository ${params.repoId} is not in the allowed scope`);
  }

  const priority = params.priority ?? 'P2';
  const payloadHash = hashCreateTaskPayload({
    title: params.title,
    description: params.description ?? null,
    priority,
    repoId: params.repoId,
  });

  // Durable, per-principal dedup receipt (survives backend restart). Scoped
  // to `authContext.tokenId` so distinct principals never collide or read
  // each other's receipt (Security details: "Scope deduplication to the
  // authenticated principal").
  const existingReceipt = db
    .query(
      'SELECT payload_hash, task_id FROM external_task_receipts WHERE token_id = ? AND idempotency_key = ?',
    )
    .get(authContext.tokenId, params.idempotencyKey) as
    | { payload_hash: string; task_id: string }
    | null;

  if (existingReceipt) {
    if (existingReceipt.payload_hash !== payloadHash) {
      throw new DomainError(
        'SEQUENCE_CONFLICT',
        `idempotencyKey ${params.idempotencyKey} was already used with a different task payload`,
      );
    }
    const existingTask = getTaskById(db, existingReceipt.task_id);
    if (!existingTask) {
      throw new DomainError(
        'NOT_FOUND',
        `receipt for idempotencyKey ${params.idempotencyKey} points to a missing task`,
      );
    }
    return existingTask;
  }

  const now = new Date().toISOString();
  let createdId = '';
  const apply = db.transaction(() => {
    const created = createTask(db, {
      title: params.title,
      description: params.description,
      priority,
      repoId: params.repoId as string,
    });
    createdId = created.id;
    db.query(
      `INSERT INTO external_task_receipts (token_id, idempotency_key, payload_hash, task_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(authContext.tokenId, params.idempotencyKey as string, payloadHash, created.id, now);
  });
  apply();

  const created = getTaskById(db, createdId);
  if (!created) {
    throw new DomainError('NOT_FOUND', `failed to create task: ${createdId}`);
  }
  return created;
}

function executeGetMessages(
  db: Database,
  authContext: McpAuthContext,
  params: { limit?: number; cursor?: string },
): unknown {
  if (authContext.role === 'mcp-managed') {
    return listMessages(db, authContext.task.conversationId, {
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  throw new DomainError('VALIDATION_ERROR', 'external get_messages requires scoped task');
}

function executePostMessage(db: Database, authContext: McpAuthContext, content: string): unknown {
  if (authContext.role === 'mcp-managed') {
    return appendMessage(db, authContext.task.conversationId, { content }, 'agent');
  }

  throw new DomainError('VALIDATION_ERROR', 'external post_message requires scoped task');
}

function executeRequestInput(
  db: Database,
  authContext: McpAuthContext,
  question: string,
): { requestId: string; question: string; status: 'hitl' } {
  if (authContext.role !== 'mcp-managed') {
    throw new DomainError('FORBIDDEN', 'request_input is only available to managed agents');
  }

  const requestId = randomUUID();
  const now = new Date().toISOString();

  const apply = db.transaction(() => {
    appendMessage(db, authContext.task.conversationId, { content: question }, 'agent');
    db.query('UPDATE runs SET status = ?, pending_input_request_id = ? WHERE id = ?').run(
      'hitl',
      requestId,
      authContext.runId,
    );
    db.query('UPDATE tasks SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(
      'hitl',
      now,
      authContext.taskId,
    );
  });
  apply();

  eventHub.publish({
    type: 'input_required',
    data: {
      requestId,
      taskId: authContext.taskId,
      conversationId: authContext.task.conversationId,
      question,
    },
  });
  const updatedTask = db
    .query('SELECT version FROM tasks WHERE id = ?')
    .get(authContext.taskId) as { version: number } | null;
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: authContext.taskId,
      status: 'hitl',
      version: updatedTask?.version ?? 1,
      updatedAt: now,
    },
  });

  return { requestId, question, status: 'hitl' };
}

function executeYieldTask(
  db: Database,
  authContext: McpAuthContext,
  params: { childTaskIds?: string[]; reason?: string },
): { ok: true; status: 'yield_requested'; taskId: string; blockedOnChildIds: string[] } {
  if (authContext.role !== 'mcp-managed') {
    throw new DomainError('FORBIDDEN', "tool 'yield_task' is managed-only");
  }

  let targetChildIds: string[] = [];

  if (params.childTaskIds && params.childTaskIds.length > 0) {
    // Verify each child belongs to current task
    for (const childId of params.childTaskIds) {
      const child = getTaskById(db, childId);
      if (!child || child.parentId !== authContext.taskId) {
        throw new DomainError(
          'FORBIDDEN',
          `task ${childId} is not a child of calling task ${authContext.taskId}`,
        );
      }
    }
    targetChildIds = params.childTaskIds;
  } else {
    // Default to all non-terminal children of calling task
    const nonTerminalRows = db
      .query(
        `SELECT id FROM tasks
         WHERE parent_id = ? AND status NOT IN ('done', 'error', 'cancelled')`,
      )
      .all(authContext.taskId) as { id: string }[];

    if (nonTerminalRows.length === 0) {
      // Check if any children exist at all
      const anyChildren = db
        .query('SELECT COUNT(*) as count FROM tasks WHERE parent_id = ?')
        .get(authContext.taskId) as { count: number };

      if (anyChildren.count === 0) {
        throw new DomainError('VALIDATION_ERROR', 'cannot yield task: parent has no child tasks');
      }
    }

    targetChildIds = nonTerminalRows.map((r) => r.id);
  }

  // A yield request is intent, never proof of process exit (specs/2026-10-24
  // -handoff-single-writer.md): no client field/header can attest process
  // exit, so this records durable intent only. Ownership stays held — task,
  // run and lock state are untouched here. The lock is only released and the
  // parent only blocked on children once the backend independently trusts
  // adapter stop evidence via `finalizeRun` (see domains/task/runs.ts).
  const result = recordYieldIntent(db, authContext.runId, {
    childTaskIds: targetChildIds,
    reason: params.reason ?? null,
  });

  if (!result.idempotent) {
    eventHub.publish({
      type: 'run.changed',
      data: {
        runId: authContext.runId,
        taskId: authContext.taskId,
        status: authContext.run.status,
        note: 'yield_requested',
      },
    });
  }

  return {
    ok: true,
    status: 'yield_requested',
    taskId: authContext.taskId,
    blockedOnChildIds: targetChildIds,
  };
}
