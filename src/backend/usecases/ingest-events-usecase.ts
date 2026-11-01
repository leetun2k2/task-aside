// Event ingestion cross-domain application action (SPECIFICATION.md §3, §7, LC-04d).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  type IngestEventsRequest,
  PERSISTENT_EVENT_TYPES,
  computeEventHash,
} from '../../contracts/event.ts';
import {
  insertInputRequiredMessage,
  touchConversationUpdatedAt,
  upsertAgentCompletedMessage,
} from '../domains/chat/repositories/message-repository.ts';
import {
  findEventReceipt,
  insertEventReceipt,
} from '../domains/task/repositories/event-receipt-repository.ts';
import { markRunHitl, refreshRunHeartbeat } from '../domains/task/repositories/run-repository.ts';
import { markTaskHitl } from '../domains/task/repositories/task-write-repository.ts';
import {
  assertFencingMatches,
  getLockForRun,
  requireRun,
  requireTask,
} from '../domains/task/runs.ts';
import {
  evaluateReceiptAction,
  validateEventRunId,
} from '../domains/task/services/event-service.ts';
import { DomainError } from '../errors.ts';
import { eventHub } from '../events/hub.ts';

export function ingestEventsUsecase(
  db: Database,
  runId: string,
  request: IngestEventsRequest,
): { ok: true } {
  const run = requireRun(db, runId);
  assertFencingMatches(run, request.ownerId, request.generation);

  // An Intake attempt never acquires a working-tree lock (specs/2026-10-25-
  // message-intake/01-contracts-and-lifecycle.md "Intake attempt ... without
  // repo locks") — the run's own owner/generation fencing (just checked
  // above) is the only applicable guard for it.
  if (run.purpose !== 'intake') {
    const lock = getLockForRun(db, runId);
    if (!lock || lock.generation !== request.generation) {
      throw new DomainError('STALE_GENERATION', `lock generation mismatch for run ${runId}`);
    }
  }

  const now = new Date().toISOString();

  const applyAtomically = db.transaction(() => {
    for (const event of request.events) {
      validateEventRunId(event, runId);

      if (PERSISTENT_EVENT_TYPES.includes(event.type)) {
        const hash = computeEventHash(event);
        const existingReceipt = findEventReceipt(db, runId, event.sequence);
        const action = evaluateReceiptAction(existingReceipt, hash, event.sequence);

        if (action === 'idempotent-skip') {
          // Identical retry: idempotent ACK, skip repeated side effect.
          continue;
        }

        insertEventReceipt(db, runId, event.sequence, hash, now);

        if (event.type === 'message.completed') {
          // An Intake attempt's final message is the raw structured JSON
          // result (01-contracts-and-lifecycle.md "Raw JSON stays in
          // execution metadata; chat gets a short decision summary"), never
          // shown to the user as-is. The engine extracts/validates it after
          // verified stop and posts the short summary itself via
          // commit-intake-result-usecase.ts.
          if (run.purpose !== 'intake') {
            const task = requireTask(db, run.task_id);
            upsertAgentCompletedMessage(db, {
              messageId: event.data.messageId,
              conversationId: task.conversationId,
              content: event.data.content,
              runId,
              sequence: event.sequence,
              createdAt: event.timestamp || now,
              originTaskId: run.task_id,
            });
            touchConversationUpdatedAt(db, task.conversationId, now);
          }
        } else if (event.type === 'input_required') {
          const task = requireTask(db, run.task_id);
          const messageId = randomUUID();
          insertInputRequiredMessage(db, {
            id: messageId,
            conversationId: task.conversationId,
            question: event.data.question,
            sourceRunId: runId,
            sourceEventSeq: event.sequence,
            createdAt: event.timestamp || now,
            originTaskId: run.task_id,
          });
          markRunHitl(db, runId, event.data.requestId, now);
          markTaskHitl(db, run.task_id, now);
          touchConversationUpdatedAt(db, task.conversationId, now);
        }
      }

      // Refresh heartbeat on any event activity
      refreshRunHeartbeat(db, runId, now);
    }
  });

  applyAtomically();

  // Post-commit fan-out to event hub (only after successful commit)
  const task = requireTask(db, run.task_id);
  for (const event of request.events) {
    if (event.type === 'message.delta') {
      eventHub.publish({
        type: 'message.delta',
        data: {
          taskId: run.task_id,
          runId,
          messageId: event.data.messageId,
          delta: event.data.delta,
        },
      });
    } else if (event.type === 'message.completed') {
      eventHub.publish({
        type: 'message.completed',
        data: {
          messageId: event.data.messageId,
          taskId: run.task_id,
          conversationId: task.conversationId,
          role: 'agent',
          content: event.data.content,
          runId,
          createdAt: event.timestamp || now,
        },
      });
    } else if (event.type === 'input_required') {
      eventHub.publish({
        type: 'input_required',
        data: {
          requestId: event.data.requestId,
          taskId: run.task_id,
          conversationId: task.conversationId,
          question: event.data.question,
        },
      });
      eventHub.publish({
        type: 'task.status_changed',
        data: {
          taskId: run.task_id,
          status: 'hitl',
          version: task.version,
          updatedAt: now,
        },
      });
    } else if (
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'cancelled'
    ) {
      eventHub.publish({
        type: 'run.changed',
        data: {
          runId,
          taskId: run.task_id,
          status: event.type,
        },
      });
    }
  }

  return { ok: true };
}
