// Create task application action (specs/2026-10-25-message-intake/00-
// overview.md, 01-contracts-and-lifecycle.md): Message is the only required
// business field. Creation atomically stores task, conversation and the
// initial chat message, and always starts in stage 'intake' — even an
// explicit title/priority/repo hint is resolved (and may be overridden by
// the user's fixed choice) rather than skipping Intake, so repo scope is
// always independently validated before any writer is dispatched
// (00-overview.md "Explicit title and priority: keep supplied title/
// priority fixed. Repository input is a hint, not a constraint.").
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { type CreateTaskInput, normalizeRepoHints } from '../../../../contracts/task.ts';
import { DomainError } from '../../../errors.ts';
import { eventHub } from '../../../events/hub.ts';
import { insertConversation } from '../../chat/repositories/conversation-repository.ts';
import {
  findConversationById,
  insertMessageRecord,
} from '../../chat/repositories/message-repository.ts';
import { listRepositories } from '../repositories.ts';
import type { TaskRecord } from '../repositories/task-query-repository.ts';
import {
  countChildrenByParentId,
  insertTask,
  setTaskInitialMessageId,
} from '../repositories/task-write-repository.ts';
import { validateChildTaskRules } from '../services/task-service.ts';
import { getTaskUsecase, requireTaskUsecase } from './get-task-usecase.ts';

export interface CreateTaskOptions {
  beforeCommit?: (task: TaskRecord) => void;
  /** Caller's authorized repo set. Browser/local callers may use the full
   * registered catalog (01-contracts-and-lifecycle.md "Browser submissions
   * can use the registered catalog available to that user."); a restricted
   * external/managed caller must pass its own narrower set — never widened
   * here. */
  authorizedRepoIds?: string[];
  /** Set when an active Intake run (not yet a committed `delegate` outcome)
   * creates this task via MCP `create_task` (01-contracts-and-lifecycle.md
   * "Children are persisted but staged and unrunnable until Intake result
   * acceptance and verified stop."). Overrides whatever block_kind
   * `waitForTaskIds` would otherwise compute; commit-intake-result-usecase.ts
   * clears this once the parent's `delegate` outcome is accepted — promoting
   * a verification task (which keeps its `waitForTaskIds`) to the ordinary
   * 'prerequisites' block instead of fully activating it. */
  stageUntilDelegationAccepted?: boolean;
  /** Managed child identity (01-contracts-and-lifecycle.md "Child creation
   * stays MCP-owned ... stable child identity"): a duplicate MCP call with
   * the same (originRunId, originKey) returns the same child, enforced by
   * the existing `idx_tasks_origin_dedup` unique index. */
  originRunId?: string;
  originKey?: string;
}

export function createTaskUsecase(
  db: Database,
  input: CreateTaskInput,
  options?: CreateTaskOptions,
): TaskRecord {
  if (options?.originRunId && options?.originKey) {
    const existing = findTaskByOrigin(db, options.originRunId, options.originKey);
    if (existing) {
      return existing;
    }
  }

  const candidateRepoIds = normalizeRepoHints(input);

  const authorizedRepoIds = options?.authorizedRepoIds ?? listRepositories(db).map((r) => r.id);
  for (const repoId of candidateRepoIds) {
    if (!authorizedRepoIds.includes(repoId)) {
      throw new DomainError('FORBIDDEN', `repository ${repoId} is not in the authorized scope`);
    }
  }

  let depth: 0 | 1 = 0;
  let parent: TaskRecord | null = null;
  if (input.parentId) {
    parent = getTaskUsecase(db, input.parentId);
    if (!parent) {
      throw new DomainError('NOT_FOUND', `parent task not found: ${input.parentId}`);
    }
    const childCount = countChildrenByParentId(db, parent.id);
    const rules = validateChildTaskRules(parent, childCount);
    depth = rules.depth;

    const parentAuth = new Set(parent.authorizedRepoIds ?? []);
    for (const repoId of candidateRepoIds) {
      if (!parentAuth.has(repoId)) {
        throw new DomainError(
          'FORBIDDEN',
          `repository ${repoId} is outside parent's authorized scope`,
        );
      }
    }
  }

  const effectiveAuthorizedRepoIds = parent
    ? authorizedRepoIds.filter((id) => (parent.authorizedRepoIds ?? []).includes(id))
    : authorizedRepoIds;

  if (input.waitForTaskIds && input.waitForTaskIds.length > 0 && !input.parentId) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'waitForTaskIds is only valid together with parentId (a verification task)',
    );
  }
  if (input.waitForTaskIds) {
    for (const prereqId of input.waitForTaskIds) {
      if (prereqId === input.parentId) {
        throw new DomainError('VALIDATION_ERROR', 'a verification task cannot wait on its parent');
      }
      const prereq = getTaskUsecase(db, prereqId);
      if (!prereq || prereq.parentId !== input.parentId) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `waitForTaskIds entry ${prereqId} is not a sibling work child of parentId ${input.parentId}`,
        );
      }
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const priority = input.priority ?? 'P2';
  const messageId = randomUUID();

  let conversationId = input.conversationId;
  if (conversationId) {
    // Reusing a conversation requires it to already exist — a caller cannot
    // invent an id and have one silently created, which would defeat the
    // "reuse requires access to the whole conversation" authorization model
    // (04-delegation-and-follow-up.md).
    if (!findConversationById(db, conversationId)) {
      throw new DomainError('NOT_FOUND', `conversation not found: ${conversationId}`);
    }
    if (parent && conversationId !== parent.conversationId) {
      throw new DomainError(
        'FORBIDDEN',
        `child task cannot bind to a conversation different from parent`,
      );
    }
  } else {
    conversationId = randomUUID();
  }

  const hasPrerequisites = Boolean(input.waitForTaskIds && input.waitForTaskIds.length > 0);
  const staged = options?.stageUntilDelegationAccepted === true;

  let created: TaskRecord | null = null;

  const applyAtomically = db.transaction(() => {
    if (!input.conversationId) {
      insertConversation(db, conversationId as string, now, now);
    }

    insertTask(db, {
      id,
      repositoryId: null,
      conversationId: conversationId as string,
      parentId: input.parentId ?? null,
      title: input.title ?? deriveShortTitle(input.message),
      description: null,
      priority,
      // Legacy dispatch code paths still read `agent_provider`; it is
      // overwritten once Intake resolves `executionProvider`
      // (resolveTaskFromIntake). A placeholder default never dispatches
      // anything on its own — stage 'intake' blocks the implementation
      // claim until that resolution happens.
      agentProvider: 'claude',
      depth,
      createdAt: now,
      enqueuedAt: now,
      updatedAt: now,
      candidateRepoIds: candidateRepoIds.length > 0 ? candidateRepoIds : null,
      authorizedRepoIds: effectiveAuthorizedRepoIds,
      resolvedRepoIds: null,
      stage: 'intake',
      // A verification task (waitForTaskIds set) is staged until every
      // listed work child is terminal (04-delegation-and-follow-up.md
      // "Before prerequisites finish, verification stays 'todo' with a
      // visible prerequisite reason. It holds no slot, run or repository
      // lock."); reconcileBlockedParents (tasks.ts) already unblocks any
      // `blocked_on_child_ids` set once every listed id is terminal — the
      // mechanism is identical regardless of whether the ids are literal
      // MCP children or a bounded prerequisite list.
      blockKind: staged ? 'staged_by_parent_intake' : hasPrerequisites ? 'prerequisites' : null,
      blockedReason: staged
        ? 'Waiting for the delegating task to accept this handoff'
        : hasPrerequisites
          ? 'Waiting for prerequisite tasks to finish'
          : null,
      blockedOnChildIds: hasPrerequisites ? (input.waitForTaskIds as string[]) : null,
      titleIsOverride: input.title !== undefined,
      priorityIsOverride: input.priority !== undefined,
      originRunId: options?.originRunId ?? null,
      originKey: options?.originKey ?? null,
    });

    insertMessageRecord(db, {
      id: messageId,
      conversationId: conversationId as string,
      role: 'user',
      content: input.message,
      inReplyToRequestId: null,
      createdAt: now,
      originTaskId: id,
    });
    setTaskInitialMessageId(db, id, messageId);

    created = requireTaskUsecase(db, id);

    if (options?.beforeCommit) {
      options.beforeCommit(created);
    }
  });

  applyAtomically();

  if (!created) {
    throw new DomainError('NOT_FOUND', `failed to create task: ${id}`);
  }

  const result: TaskRecord = created;

  // Defer publication until AFTER the outer transaction commits!
  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: result.id,
      status: result.status,
      version: result.version,
      blockedReason: result.blockedReason,
      updatedAt: result.updatedAt,
    },
  });

  return result;
}

function findTaskByOrigin(db: Database, originRunId: string, originKey: string): TaskRecord | null {
  const row = db
    .query('SELECT id FROM tasks WHERE origin_run_id = ? AND origin_key = ?')
    .get(originRunId, originKey) as { id: string } | null;
  return row ? getTaskUsecase(db, row.id) : null;
}

/** Deterministic short title from the first nonblank Message line
 * (01-contracts-and-lifecycle.md "Until Intake succeeds, show a
 * deterministic short title from the first nonblank Message line"). Not a
 * user override — Intake may replace it entirely. */
function deriveShortTitle(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const text = firstLine ?? message.trim();
  const MAX_LEN = 80;
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
}
