// Input-required cross-domain application action (SPECIFICATION.md §2, ARCHITECTURE.md §3, LC-04c).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  insertInputRequiredMessage,
  touchConversationUpdatedAt,
} from '../domains/chat/repositories/message-repository.ts';
import { markRunHitl } from '../domains/task/repositories/run-repository.ts';
import { findTaskRowById } from '../domains/task/repositories/task-query-repository.ts';
import { markTaskHitl } from '../domains/task/repositories/task-write-repository.ts';
import { eventHub } from '../events/hub.ts';

export interface RequestInputParams {
  runId: string;
  taskId: string;
  conversationId: string;
  requestId: string;
  question: string;
  sourceRunId?: string | null;
  sourceEventSeq?: number | null;
  createdAt?: string;
}

export interface RequestInputResult {
  requestId: string;
  question: string;
  status: 'hitl';
  version: number;
}

export function recordInputRequired(db: Database, params: RequestInputParams): RequestInputResult {
  const messageId = randomUUID();
  const now = params.createdAt ?? new Date().toISOString();
  let taskVersion = 1;

  const applyAtomically = db.transaction(() => {
    insertInputRequiredMessage(db, {
      id: messageId,
      conversationId: params.conversationId,
      question: params.question,
      sourceRunId: params.sourceRunId ?? null,
      sourceEventSeq: params.sourceEventSeq ?? null,
      createdAt: now,
      originTaskId: params.taskId,
    });

    markRunHitl(db, params.runId, params.requestId, now);
    markTaskHitl(db, params.taskId, now);
    touchConversationUpdatedAt(db, params.conversationId, now);

    const taskRow = findTaskRowById(db, params.taskId);
    taskVersion = taskRow?.version ?? 1;
  });

  applyAtomically();

  // Defer publication until AFTER outer commit
  eventHub.publish({
    type: 'input_required',
    data: {
      requestId: params.requestId,
      taskId: params.taskId,
      conversationId: params.conversationId,
      question: params.question,
    },
  });

  eventHub.publish({
    type: 'task.status_changed',
    data: {
      taskId: params.taskId,
      status: 'hitl',
      previousStatus: 'processing',
      version: taskVersion,
      updatedAt: now,
    },
  });

  return {
    requestId: params.requestId,
    question: params.question,
    status: 'hitl',
    version: taskVersion,
  };
}
