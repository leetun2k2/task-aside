// Event ingestion domain (SPECIFICATION.md §3, §7, ARCHITECTURE.md §6; T13):
// transactional event ingestion, monotonic sequence enforcement, event hash
// deduplication, message persistence, input_required pairing, and lost-ACK retry.
// Only `src/backend` may open SQLite (AGENTS.md §3).
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  type IngestEventsRequest,
  PERSISTENT_EVENT_TYPES,
  computeEventHash,
} from '../../../contracts/event.ts';
import { DomainError } from '../../api/errors.ts';
import { eventHub } from '../../events/hub.ts';
import { assertFencingMatches, getLockForRun, requireRun, requireTask } from './runs.ts';

export function ingestEvents(
  db: Database,
  runId: string,
  request: IngestEventsRequest,
): { ok: true } {
  const run = requireRun(db, runId);
  assertFencingMatches(run, request.ownerId, request.generation);

  const lock = getLockForRun(db, runId);
  if (!lock || lock.generation !== request.generation) {
    throw new DomainError('STALE_GENERATION', `lock generation mismatch for run ${runId}`);
  }

  const now = new Date().toISOString();

  const applyAtomically = db.transaction(() => {
    for (const event of request.events) {
      if (event.runId !== runId) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `event runId mismatch: expected ${runId}, got ${event.runId}`,
        );
      }

      if (PERSISTENT_EVENT_TYPES.includes(event.type)) {
        const hash = computeEventHash(event);
        const existingReceipt = db
          .query('SELECT event_hash FROM run_event_receipts WHERE run_id = ? AND sequence = ?')
          .get(runId, event.sequence) as { event_hash: string } | null;

        if (existingReceipt) {
          if (existingReceipt.event_hash !== hash) {
            throw new DomainError(
              'SEQUENCE_CONFLICT',
              `sequence ${event.sequence} already recorded with a different payload`,
            );
          }
          // Identical retry: idempotent ACK, skip repeated side effect.
          continue;
        }

        // Record persistent event receipt
        db.query(
          `INSERT INTO run_event_receipts (run_id, sequence, event_hash, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(runId, event.sequence, hash, now);

        if (event.type === 'message.completed') {
          const task = requireTask(db, run.task_id);
          db.query(
            `INSERT INTO messages
              (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
               source_event_seq, created_at)
             VALUES (?, ?, 'agent', ?, NULL, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               content = excluded.content,
               source_run_id = excluded.source_run_id,
               source_event_seq = excluded.source_event_seq`,
          ).run(
            event.data.messageId,
            task.conversationId,
            event.data.content,
            runId,
            event.sequence,
            event.timestamp || now,
          );
          db.query('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
            now,
            task.conversationId,
          );
        } else if (event.type === 'input_required') {
          const task = requireTask(db, run.task_id);
          const messageId = randomUUID();
          db.query(
            `INSERT INTO messages
              (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
               source_event_seq, created_at)
             VALUES (?, ?, 'agent', ?, NULL, ?, ?, ?)`,
          ).run(
            messageId,
            task.conversationId,
            event.data.question,
            runId,
            event.sequence,
            event.timestamp || now,
          );
          db.query(
            `UPDATE runs
             SET status = 'hitl', pending_input_request_id = ?, heartbeat_at = ?
             WHERE id = ?`,
          ).run(event.data.requestId, now, runId);
          db.query(
            "UPDATE tasks SET status = 'hitl', updated_at = ?, version = version + 1 WHERE id = ?",
          ).run(now, run.task_id);
          db.query('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
            now,
            task.conversationId,
          );
        }
      }

      // Refresh heartbeat on any event activity
      db.query('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(now, runId);
    }
  });

  applyAtomically();

  // Post-commit fan-out to event hub
  const task = requireTask(db, run.task_id);
  for (const event of request.events) {
    if (event.type === 'message.delta') {
      eventHub.publish({
        type: 'message.delta',
        data: {
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
