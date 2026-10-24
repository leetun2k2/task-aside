// Run context read projections (RF-39).
// Pure read-only queries for run/task context assembly without write transactions or locks.
import type { Database } from 'bun:sqlite';
import type { Message } from '../../../contracts/chat.ts';
import type { Repository } from '../../../contracts/task.ts';
import { listMessages } from '../chat/messages.ts';
import { requireRepositoryForTask, requireTask } from './runs.ts';
import { type TaskRecord, getTaskById } from './tasks.ts';

export interface ChildTaskSummary {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  errorMessage: string | null;
}

export interface TaskContext {
  task: TaskRecord;
  repository: Repository;
  parent: TaskRecord | null;
  conversation: { id: string; createdAt: string; updatedAt: string } | null;
  messages: Message[];
  children?: ChildTaskSummary[];
}

export function getTaskContext(db: Database, taskId: string): TaskContext {
  const task = requireTask(db, taskId);
  const repository = requireRepositoryForTask(db, task);
  const parent = task.parentId ? getTaskById(db, task.parentId) : null;

  const conversationRow = db
    .query('SELECT id, created_at, updated_at FROM conversations WHERE id = ?')
    .get(task.conversationId) as { id: string; created_at: string; updated_at: string } | null;

  const { messages } = listMessages(db, task.conversationId, { limit: 200 });

  // Query child tasks if any
  const childRows = db
    .query(
      'SELECT id, title, status, blocked_reason FROM tasks WHERE parent_id = ? ORDER BY created_at ASC',
    )
    .all(taskId) as { id: string; title: string; status: string; blocked_reason: string | null }[];

  const children: ChildTaskSummary[] = childRows.map((child) => {
    const latestRun = db
      .query('SELECT process_state FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(child.id) as { process_state: string | null } | null;
    let summary: string | null = null;
    let errorMessage: string | null = child.blocked_reason;
    if (latestRun?.process_state) {
      try {
        const parsed = JSON.parse(latestRun.process_state);
        summary = parsed.summary ?? null;
        if (!errorMessage && parsed.errorMessage) {
          errorMessage = parsed.errorMessage;
        }
      } catch {}
    }
    return {
      id: child.id,
      title: child.title,
      status: child.status,
      summary,
      errorMessage,
    };
  });

  return {
    task,
    repository,
    parent,
    conversation: conversationRow
      ? {
          id: conversationRow.id,
          createdAt: conversationRow.created_at,
          updatedAt: conversationRow.updated_at,
        }
      : null,
    messages,
    children: children.length > 0 ? children : undefined,
  };
}
