// Run context read projections (SPECIFICATION.md §2, RF-39, LC-03a).
import type { Database } from 'bun:sqlite';
import type { Message } from '../../../../contracts/chat.ts';
import type { Repository } from '../../../../contracts/task.ts';
import { DomainError } from '../../../errors.ts';
import { listMessages } from '../../chat/messages.ts';
import { getRepositoryById } from '../repositories.ts';
import {
  type ChildTaskSummary,
  type TaskRecord,
  findChildTaskSummaries,
  findConversationRow,
} from '../repositories/task-query-repository.ts';
import { getTaskUsecase, requireTaskUsecase } from './get-task-usecase.ts';

export interface TaskContext {
  task: TaskRecord;
  // Null while stage === 'intake' and no repo has been resolved yet
  // (specs/2026-10-25-message-intake/01-contracts-and-lifecycle.md "Intake
  // context boundary ... currently requires one repository"). The
  // implementation claim always resolves this before dispatch; only the
  // Intake dispatch path ever sees it null.
  repository: Repository | null;
  resolvedRepositories?: Repository[];
  authorizedRepositories?: Repository[];
  parent: TaskRecord | null;
  conversation: { id: string; createdAt: string; updatedAt: string } | null;
  messages: Message[];
  children?: ChildTaskSummary[];
}

export function getTaskContextUsecase(db: Database, taskId: string): TaskContext {
  const task = requireTaskUsecase(db, taskId);
  const repository = task.repoId ? getRepositoryById(db, task.repoId) : null;
  if (task.repoId && !repository) {
    throw new DomainError('NOT_FOUND', `repository not found: ${task.repoId}`);
  }

  // Multi-repo resolved scope: load every resolved repository
  let resolvedRepositories: Repository[] | undefined;
  if (task.resolvedRepoIds && task.resolvedRepoIds.length > 0) {
    resolvedRepositories = task.resolvedRepoIds.map((id) => {
      const repo = getRepositoryById(db, id);
      if (!repo) {
        throw new DomainError('NOT_FOUND', `resolved repository not found: ${id}`);
      }
      return repo;
    });
  } else if (repository) {
    resolvedRepositories = [repository];
  }

  // Intake receives only authorized repository metadata — id, name,
  // canonical path, declared description — never a filesystem scan
  // (01-contracts-and-lifecycle.md "Candidate scope is permission, resolved
  // scope is intent"). Authorization was captured at creation time in
  // `authorizedRepoIds`; this re-reads the current registry rows for those
  // ids so a since-deleted repo cannot be silently offered.
  const authorizedRepositories = task.authorizedRepoIds
    ? (task.authorizedRepoIds
        .map((id) => getRepositoryById(db, id))
        .filter((r): r is Repository => r !== null))
    : undefined;

  const parent = task.parentId ? getTaskUsecase(db, task.parentId) : null;
  const conversationRow = findConversationRow(db, task.conversationId);
  const { messages } = listMessages(db, task.conversationId, { limit: 200 });
  const children = findChildTaskSummaries(db, taskId);

  return {
    task,
    repository,
    resolvedRepositories,
    authorizedRepositories,
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
