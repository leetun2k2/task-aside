// Automated event ingestion, dedup, and pending input verification suite (T13).
// Run: bun run src/backend/event-checks.ts
import type { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { EventEnvelope } from '../contracts/event.ts';
import { internalAuth } from '../supervisor/auth.ts';
import { mountInternalApi, mountPublicApi } from './api/index.ts';
import { closeDatabase, openDatabase } from './db/connection.ts';
import { runMigrations } from './db/migrations.ts';
import { listMessages } from './domains/chat/messages.ts';
import { createRepository } from './domains/task/repositories.ts';
import { createTask } from './domains/task/tasks.ts';

type CheckResult = { name: string; passed: boolean; error?: string };
const results: CheckResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, passed: true });
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ name, passed: false, error });
    });
}

process.env.TASKASIDE_INTERNAL_TOKEN = 'test-internal-token';

// biome-ignore lint/suspicious/noExplicitAny: test helper response type
type TestResponseBody = any;

function buildApp(db: Database): Hono {
  const app = new Hono();
  mountPublicApi(app, db);
  mountInternalApi(app, db);
  return app;
}

async function internalRequest(
  app: Hono,
  method: string,
  path: string,
  role: 'engine' | 'supervisor',
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: TestResponseBody }> {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-internal-token',
    'X-TaskAside-Role': role,
    ...extraHeaders,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: TestResponseBody = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function publicRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: TestResponseBody }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: TestResponseBody = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-events-test-'));
  const dbPath = join(tempDir, 'taskaside.db');
  const repoDir = join(tempDir, 'repo');
  mkdirSync(repoDir, { recursive: true });

  const db = openDatabase({ path: dbPath });
  runMigrations(db);
  const app = buildApp(db);

  try {
    const repo = createRepository(db, {
      name: 'Event Repo',
      displayPath: repoDir,
      defaultProvider: 'claude',
    });

    const task = createTask(db, {
      title: 'Events Verification Task',
      repoId: repo.id,
      priority: 'P1',
    });

    let runId = '';
    let generation = 0;
    const ownerId = 'engine-test-owner';

    // 1. Initial claim to start a run
    await check('claim task to establish active run and lock generation', async () => {
      const res = await internalRequest(
        app,
        'POST',
        `/internal/v1/tasks/${task.id}/claim`,
        'engine',
        {
          ownerId,
          generation: 0,
          idempotencyKey: 'claim-1',
        },
      );
      assert(res.status === 200, `expected 200 claim, got ${res.status}`);
      runId = res.body.runId;
      generation = res.body.generation;
      assert(runId.startsWith('run_'), `expected runId prefix, got ${runId}`);
      assert(generation === 1, `expected generation 1, got ${generation}`);
    });

    // 2. Ingest message.completed: persists message & receipt
    await check('ingest message.completed persists agent message and receipt', async () => {
      const event: EventEnvelope = {
        runId,
        sequence: 1,
        type: 'message.completed',
        timestamp: new Date().toISOString(),
        data: { messageId: 'msg_001', content: 'Step 1 completed successfully.' },
      };
      const res = await internalRequest(
        app,
        'POST',
        `/internal/v1/runs/${runId}/events`,
        'engine',
        {
          ownerId,
          generation,
          events: [event],
        },
      );
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.body.ok === true, 'expected ok: true');

      const receipt = db
        .query('SELECT event_hash FROM run_event_receipts WHERE run_id = ? AND sequence = ?')
        .get(runId, 1) as { event_hash: string } | null;
      assert(receipt !== null, 'expected receipt in run_event_receipts');

      const { messages } = listMessages(db, task.conversationId);
      assert(messages.length === 1, `expected 1 message, got ${messages.length}`);
      assert(
        messages[0].content === 'Step 1 completed successfully.',
        'expected message content match',
      );
      assert(messages[0].sender === 'agent', 'expected sender agent');
    });

    // 3. Identical retry: returns 200 without duplicate message
    await check(
      'identical retry of message.completed returns 200 without duplicate message',
      async () => {
        const event: EventEnvelope = {
          runId,
          sequence: 1,
          type: 'message.completed',
          timestamp: new Date().toISOString(),
          data: { messageId: 'msg_001', content: 'Step 1 completed successfully.' },
        };
        const res = await internalRequest(
          app,
          'POST',
          `/internal/v1/runs/${runId}/events`,
          'engine',
          {
            ownerId,
            generation,
            events: [event],
          },
        );
        assert(res.status === 200, `expected 200 identical retry, got ${res.status}`);

        const { messages } = listMessages(db, task.conversationId);
        assert(messages.length === 1, `expected still 1 message, got ${messages.length}`);
      },
    );

    // 4. Sequence conflict: different payload at same sequence -> 409 SEQUENCE_CONFLICT
    await check(
      'sequence conflict: different payload at same sequence -> 409 SEQUENCE_CONFLICT',
      async () => {
        const conflictingEvent: EventEnvelope = {
          runId,
          sequence: 1,
          type: 'message.completed',
          timestamp: new Date().toISOString(),
          data: { messageId: 'msg_001_diff', content: 'Different content for sequence 1' },
        };
        const res = await internalRequest(
          app,
          'POST',
          `/internal/v1/runs/${runId}/events`,
          'engine',
          {
            ownerId,
            generation,
            events: [conflictingEvent],
          },
        );
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(
          res.body.code === 'SEQUENCE_CONFLICT',
          `expected SEQUENCE_CONFLICT, got ${res.body.code}`,
        );
      },
    );

    // 5. Lost ACK simulation: drop ACK after commit, identical retry succeeds
    await check(
      'lost ACK simulation: retry after dropped response is acknowledged idempotently',
      async () => {
        const lostAckEvent: EventEnvelope = {
          runId,
          sequence: 2,
          type: 'message.completed',
          timestamp: new Date().toISOString(),
          data: { messageId: 'msg_002', content: 'Message committed but ACK dropped.' },
        };

        const dropped = await internalRequest(
          app,
          'POST',
          `/internal/v1/runs/${runId}/events`,
          'engine',
          {
            ownerId,
            generation,
            events: [lostAckEvent],
          },
          { 'x-simulate-lost-ack': 'true' },
        );
        assert(dropped.status === 503, `expected 503 simulated drop, got ${dropped.status}`);

        // Verify the event was committed to DB despite the dropped response
        const receipt = db
          .query('SELECT event_hash FROM run_event_receipts WHERE run_id = ? AND sequence = ?')
          .get(runId, 2);
        assert(receipt !== null, 'expected sequence 2 receipt committed in DB');

        // Retry identical tuple
        const retry = await internalRequest(
          app,
          'POST',
          `/internal/v1/runs/${runId}/events`,
          'engine',
          {
            ownerId,
            generation,
            events: [lostAckEvent],
          },
        );
        assert(retry.status === 200, `expected 200 on retry, got ${retry.status}`);

        const { messages } = listMessages(db, task.conversationId);
        assert(
          messages.length === 2,
          `expected exactly 2 messages in conversation, got ${messages.length}`,
        );
      },
    );

    // 6. Stale generation fencing check on events
    await check(
      'events rejection on stale generation or ownerId -> 409 STALE_GENERATION',
      async () => {
        const event: EventEnvelope = {
          runId,
          sequence: 3,
          type: 'message.completed',
          timestamp: new Date().toISOString(),
          data: { messageId: 'msg_003', content: 'Stale attempt' },
        };
        const res = await internalRequest(
          app,
          'POST',
          `/internal/v1/runs/${runId}/events`,
          'engine',
          {
            ownerId: 'wrong-owner',
            generation,
            events: [event],
          },
        );
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(
          res.body.code === 'STALE_GENERATION',
          `expected STALE_GENERATION, got ${res.body.code}`,
        );
      },
    );

    // 7. Transient message.delta does not persist in DB
    await check(
      'transient message.delta is accepted without creating receipts or messages',
      async () => {
        const deltaEvent: EventEnvelope = {
          runId,
          sequence: 99,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'msg_stream', delta: 'partial token' },
        };
        const res = await internalRequest(
          app,
          'POST',
          `/internal/v1/runs/${runId}/events`,
          'engine',
          {
            ownerId,
            generation,
            events: [deltaEvent],
          },
        );
        assert(res.status === 200, `expected 200, got ${res.status}`);

        const receipt = db
          .query('SELECT event_hash FROM run_event_receipts WHERE run_id = ? AND sequence = ?')
          .get(runId, 99);
        assert(receipt === null, 'expected no receipt for message.delta');
      },
    );

    // 8. User message during processing queues without changing status
    await check(
      'active processing task queues user message without interrupting state',
      async () => {
        const res = await publicRequest(
          app,
          'POST',
          `/api/conversations/${task.conversationId}/messages`,
          { content: 'User comment during active processing' },
        );
        assert(res.status === 201, `expected 201, got ${res.status}`);

        const taskRow = db.query('SELECT status FROM tasks WHERE id = ?').get(task.id) as {
          status: string;
        };
        assert(
          taskRow.status === 'processing',
          `task must remain processing, got ${taskRow.status}`,
        );
      },
    );

    // 9. Ingest input_required: transitions run and task to hitl, records pending_input_request_id
    await check(
      'ingest input_required moves task and run to hitl with pending request id',
      async () => {
        const hitlEvent: EventEnvelope = {
          runId,
          sequence: 3,
          type: 'input_required',
          timestamp: new Date().toISOString(),
          data: { requestId: 'req_qa_001', question: 'Should we migrate the database schema?' },
        };
        const res = await internalRequest(
          app,
          'POST',
          `/internal/v1/runs/${runId}/events`,
          'engine',
          {
            ownerId,
            generation,
            events: [hitlEvent],
          },
        );
        assert(res.status === 200, `expected 200, got ${res.status}`);

        const runRow = db
          .query('SELECT status, pending_input_request_id FROM runs WHERE id = ?')
          .get(runId) as {
          status: string;
          pending_input_request_id: string;
        };
        assert(runRow.status === 'hitl', `expected run status hitl, got ${runRow.status}`);
        assert(
          runRow.pending_input_request_id === 'req_qa_001',
          `expected pending_input_request_id req_qa_001, got ${runRow.pending_input_request_id}`,
        );

        const taskRow = db.query('SELECT status FROM tasks WHERE id = ?').get(task.id) as {
          status: string;
        };
        assert(taskRow.status === 'hitl', `expected task status hitl, got ${taskRow.status}`);
      },
    );

    // 10. Mismatched or stale inReplyToRequestId rejected with 409 REQUEST_ALREADY_RESOLVED
    await check(
      'reply with mismatched inReplyToRequestId returns 409 REQUEST_ALREADY_RESOLVED',
      async () => {
        const res = await publicRequest(
          app,
          'POST',
          `/api/conversations/${task.conversationId}/messages`,
          { content: 'Stale answer', inReplyToRequestId: 'req_wrong_id' },
        );
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(
          res.body.code === 'REQUEST_ALREADY_RESOLVED',
          `expected REQUEST_ALREADY_RESOLVED, got ${res.body.code}`,
        );
      },
    );

    // 11. Atomic HITL reply: matching inReplyToRequestId resumes run to running, task to processing
    await check(
      'matching inReplyToRequestId atomically inserts reply, clears pending request, resumes task',
      async () => {
        const res = await internalRequest(
          app,
          'POST',
          `/internal/v1/tasks/${task.id}/messages`,
          'engine',
          { content: 'Yes, proceed with migration.', inReplyToRequestId: 'req_qa_001' },
        );
        assert(res.status === 200, `expected 200 on reply, got ${res.status}`);
        assert(res.body.ok === true, 'expected ok: true');

        const runRow = db
          .query('SELECT status, pending_input_request_id FROM runs WHERE id = ?')
          .get(runId) as {
          status: string;
          pending_input_request_id: string | null;
        };
        assert(runRow.status === 'running', `expected run status running, got ${runRow.status}`);
        assert(
          runRow.pending_input_request_id === null,
          'expected pending_input_request_id to be cleared',
        );

        const taskRow = db.query('SELECT status FROM tasks WHERE id = ?').get(task.id) as {
          status: string;
        };
        assert(
          taskRow.status === 'processing',
          `expected task status processing, got ${taskRow.status}`,
        );
      },
    );

    // 12. Duplicate reply with same inReplyToRequestId returns 409 REQUEST_ALREADY_RESOLVED
    await check(
      'duplicate HITL reply with same inReplyToRequestId returns 409 REQUEST_ALREADY_RESOLVED',
      async () => {
        const res = await internalRequest(
          app,
          'POST',
          `/internal/v1/tasks/${task.id}/messages`,
          'engine',
          { content: 'Yes, proceed with migration again.', inReplyToRequestId: 'req_qa_001' },
        );
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(
          res.body.code === 'REQUEST_ALREADY_RESOLVED',
          `expected REQUEST_ALREADY_RESOLVED, got ${res.body.code}`,
        );
      },
    );

    // 13. Message to terminal task does not resurrect execution
    await check('message to terminal task does not resurrect execution', async () => {
      // Finalize the run to 'done'
      const finalizeRes = await internalRequest(
        app,
        'POST',
        `/internal/v1/runs/${runId}/finalize`,
        'engine',
        {
          ownerId,
          generation,
          status: 'done',
          verifiedStopped: true,
          verificationMethod: 'process_group_empty',
          summary: 'All done',
        },
      );
      assert(finalizeRes.status === 200, `expected finalize 200, got ${finalizeRes.status}`);

      const taskDone = db.query('SELECT status FROM tasks WHERE id = ?').get(task.id) as {
        status: string;
      };
      assert(taskDone.status === 'done', `expected task done, got ${taskDone.status}`);

      // Post user message to done task
      const postRes = await publicRequest(
        app,
        'POST',
        `/api/conversations/${task.conversationId}/messages`,
        { content: 'A follow-up remark on completed task' },
      );
      assert(postRes.status === 201, `expected 201, got ${postRes.status}`);

      const taskStillDone = db.query('SELECT status FROM tasks WHERE id = ?').get(task.id) as {
        status: string;
      };
      assert(
        taskStillDone.status === 'done',
        `task must remain done after follow-up message, got ${taskStillDone.status}`,
      );
    });
  } finally {
    closeDatabase(db);
    rmSync(tempDir, { recursive: true, force: true });
  }

  // Print summary
  let failed = 0;
  console.log('\nT13 Event Ingestion & Pending Input Verification Suite:');
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✓ ${r.name}`);
    } else {
      console.log(`  ✗ ${r.name}: ${r.error}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} checks failed.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} checks passed.`);
  }
}

main().catch((err) => {
  console.error('Fatal error in event-checks:', err);
  process.exit(1);
});
