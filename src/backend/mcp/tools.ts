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
import { appendMessage, listMessages } from '../domains/chat/messages.ts';
import { appendMessageUsecase } from '../domains/chat/usecases/append-message-usecase.ts';
import { listMessagesUsecase } from '../domains/chat/usecases/list-messages-usecase.ts';
import { getRepositoryById } from '../domains/task/repositories.ts';
import { recordYieldIntent } from '../domains/task/runs.ts';
import {
  TASK_COLUMNS,
  type TaskRecord,
  type TaskRow,
  listTasks as domainListTasks,
  getTaskById,
  rowToTask,
} from '../domains/task/tasks.ts';
import { createTaskUsecase } from '../domains/task/usecases/create-task-usecase.ts';
import { DomainError } from '../errors.ts';
import { eventHub } from '../events/hub.ts';
import { recordInputRequired } from '../usecases/request-input-usecase.ts';
import type { McpAuthContext } from './tokens.ts';

function hashCreateTaskPayload(payload: {
  message: string;
  title?: string;
  priority?: TaskPriority;
  repoId?: string;
  repoIds?: string[];
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
    // An unresolved (stage 'intake') task has no repoId yet; a repo-scoped
    // external token cannot see it until Intake resolves one — it is not
    // "in scope by default" just because the check can't run.
    if (authContext.allowedRepoIds && (!t.repoId || !authContext.allowedRepoIds.has(t.repoId))) {
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

  if (authContext.allowedRepoIds && (!task.repoId || !authContext.allowedRepoIds.has(task.repoId))) {
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
    message: string;
    title?: string;
    description?: string;
    priority?: TaskPriority;
    idempotencyKey?: string;
    repoId?: string;
    repoIds?: string[];
    parentId?: string;
    conversationId?: string;
    waitForTaskIds?: string[];
  },
): TaskRecord {
  if (authContext.role === 'mcp-managed') {
    // Managed agent: `parentId` is forced to the calling task's own ID
    // regardless of what the caller passed (specs/2026-10-25-message-
    // intake/01-contracts-and-lifecycle.md "Backend rejects any other
    // parent"). Repo scope is NOT inherited from the parent — Intake
    // resolves its own scope for the new task via its own fresh Intake
    // attempt; `repoId`/`repoIds` here are hints like any other creation.
    if (!canCreateChildTask(authContext.task.depth)) {
      throw new DomainError(
        'CHILD_LIMIT_EXCEEDED',
        'parent task is itself a child; grandchildren are not allowed',
      );
    }

    const childCountRow = db
      .query('SELECT COUNT(*) as count FROM tasks WHERE parent_id = ?')
      .get(authContext.taskId) as { count: number };
    if (!isWithinChildLimit(childCountRow.count)) {
      throw new DomainError(
        'CHILD_LIMIT_EXCEEDED',
        `parent task already has the maximum of ${MAX_CHILDREN_PER_TASK} children`,
      );
    }

    // Staged until the calling Intake attempt's `delegate` outcome is
    // accepted (01-contracts-and-lifecycle.md "Children are persisted but
    // staged and unrunnable until Intake result acceptance and verified
    // stop."). A non-Intake managed run (legacy yield_task delegation)
    // creates ordinary, immediately-eligible children exactly as before.
    const stageUntilDelegationAccepted = authContext.run.purpose === 'intake';

    return createTaskUsecase(
      db,
      {
        message: params.message,
        title: params.title,
        priority: params.priority,
        repoId: params.repoId,
        repoIds: params.repoIds,
        parentId: authContext.taskId,
        conversationId: params.conversationId,
        waitForTaskIds: params.waitForTaskIds,
      },
      {
        // The parent's own authorized scope bounds the child's — 01-
        // contracts-and-lifecycle.md "bound child authorization to the
        // parent's accepted repo scope"; before acceptance, the parent's
        // currently-authorized set is the best available bound.
        authorizedRepoIds: authContext.task.authorizedRepoIds ?? undefined,
        stageUntilDelegationAccepted,
        originRunId: authContext.runId,
        originKey: params.idempotencyKey,
      },
    );
  }

  // External caller: must explicitly supply an idempotency key — TaskAside
  // never deduplicates a Message-only call by its text (01-contracts-and-
  // lifecycle.md "do not deduplicate by Message text").
  if (!params.idempotencyKey) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'idempotencyKey is required for external task creation',
    );
  }

  // repoId/repoIds are hints, not a constraint on Intake's eventual choice
  // (01-contracts-and-lifecycle.md) — but an explicitly named hint is still
  // validated eagerly (registered + authorized) so a typo or out-of-scope
  // repo fails fast at submission instead of silently surfacing much later
  // out of Intake.
  const candidateRepoIds = params.repoIds ?? (params.repoId ? [params.repoId] : []);
  for (const repoId of candidateRepoIds) {
    if (!getRepositoryById(db, repoId)) {
      throw new DomainError('NOT_FOUND', `repository not found: ${repoId}`);
    }
    if (authContext.allowedRepoIds && !authContext.allowedRepoIds.has(repoId)) {
      throw new DomainError('FORBIDDEN', `repository ${repoId} is not in the allowed scope`);
    }
  }

  const payloadHash = hashCreateTaskPayload({
    message: params.message,
    title: params.title,
    priority: params.priority,
    repoId: params.repoId,
    repoIds: params.repoIds,
  });

  // Durable, per-principal dedup receipt (survives backend restart). Scoped
  // to `authContext.tokenId` so distinct principals never collide or read
  // each other's receipt (Security details: "Scope deduplication to the
  // authenticated principal").
  const existingReceipt = db
    .query(
      'SELECT payload_hash, task_id FROM external_task_receipts WHERE token_id = ? AND idempotency_key = ?',
    )
    .get(authContext.tokenId, params.idempotencyKey) as {
    payload_hash: string;
    task_id: string;
  } | null;

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
  const created = createTaskUsecase(
    db,
    {
      message: params.message,
      title: params.title,
      priority: params.priority,
      repoId: params.repoId,
      repoIds: params.repoIds,
      parentId: params.parentId,
      conversationId: params.conversationId,
      waitForTaskIds: params.waitForTaskIds,
    },
    {
      authorizedRepoIds: authContext.allowedRepoIds
        ? [...authContext.allowedRepoIds]
        : undefined,
      beforeCommit: (task) => {
        db.query(
          `INSERT INTO external_task_receipts (token_id, idempotency_key, payload_hash, task_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(authContext.tokenId, params.idempotencyKey as string, payloadHash, task.id, now);
      },
    },
  );

  return created;
}

function executeGetMessages(
  db: Database,
  authContext: McpAuthContext,
  params: { limit?: number; cursor?: string },
): unknown {
  if (authContext.role === 'mcp-managed') {
    return listMessagesUsecase(db, authContext.task.conversationId, {
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  throw new DomainError('VALIDATION_ERROR', 'external get_messages requires scoped task');
}

function executePostMessage(db: Database, authContext: McpAuthContext, content: string): unknown {
  if (authContext.role === 'mcp-managed') {
    return appendMessageUsecase(db, authContext.task.conversationId, { content }, 'agent');
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
  const res = recordInputRequired(db, {
    runId: authContext.runId,
    taskId: authContext.taskId,
    conversationId: authContext.task.conversationId,
    requestId,
    question,
  });

  return { requestId: res.requestId, question: res.question, status: res.status };
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
