// Automated fenced run lifecycle verification suite (T12).
// Run: bun run src/backend/run-checks.ts
import type { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { internalAuth } from '../supervisor/auth.ts';
import { mountInternalApi, mountPublicApi } from './api/index.ts';
import { closeDatabase, openDatabase } from './db/connection.ts';
import { runMigrations } from './db/migrations.ts';
import { appendMessage } from './domains/chat/messages.ts';
import { createRepository } from './domains/task/repositories.ts';
import { createTask, retryTask } from './domains/task/tasks.ts';

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
): Promise<{ status: number; body: TestResponseBody }> {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-internal-token',
    'X-TaskAside-Role': role,
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const workDir = mkdtempSync(join(tmpdir(), 'taskaside-run-checks-'));
const dbPath = join(workDir, 'taskaside.db');
const reposDir = join(workDir, 'repos');
mkdirSync(reposDir, { recursive: true });

async function main(): Promise<void> {
  const db = openDatabase({ path: dbPath });
  runMigrations(db);
  const app = buildApp(db);

  try {
    const dirA = join(reposDir, 'repo-a');
    const dirB = join(reposDir, 'repo-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const repoA = createRepository(db, {
      name: 'repo-a',
      displayPath: dirA,
      defaultProvider: 'codex',
    });
    const repoB = createRepository(db, {
      name: 'repo-b',
      displayPath: dirB,
      defaultProvider: 'codex',
    });

    function post(path: string, role: 'engine' | 'supervisor', body?: unknown) {
      return internalRequest(app, 'POST', path, role, body);
    }
    function get(path: string, role: 'engine' | 'supervisor') {
      return internalRequest(app, 'GET', path, role);
    }

    // --- 1. Claim creates run + lock, transitions task to processing --------
    const taskA = createTask(db, { title: 'Task A', repoId: repoA.id, priority: 'P2' });
    let runA = '';
    {
      await check('claim: creates run and lock, task transitions to processing', async () => {
        const res = await post(`/internal/v1/tasks/${taskA.id}/claim`, 'engine', {
          ownerId: 'owner-1',
          generation: 0,
          idempotencyKey: 'key-1',
        });
        assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(
          typeof res.body.runId === 'string' && res.body.runId.startsWith('run_'),
          'expected run_ prefixed runId',
        );
        assert(res.body.generation === 1, `expected generation 1, got ${res.body.generation}`);
        assert(typeof res.body.leaseExpiresAt === 'string', 'expected leaseExpiresAt string');
        assert(res.body.taskSnapshot.status === 'processing', 'expected task snapshot processing');
        runA = res.body.runId;

        const lockRow = db
          .query('SELECT owner_run_id, generation FROM run_locks WHERE working_tree_key = ?')
          .get(repoA.canonicalPath) as { owner_run_id: string; generation: number };
        assert(lockRow.owner_run_id === runA, 'expected lock owner to be new run');
        assert(lockRow.generation === 1, 'expected lock generation 1');
      });

      // --- 2. Duplicate claim with identical idempotencyKey is idempotent ---
      await check('claim: duplicate idempotencyKey returns existing claim', async () => {
        const res = await post(`/internal/v1/tasks/${taskA.id}/claim`, 'engine', {
          ownerId: 'owner-1',
          generation: 0,
          idempotencyKey: 'key-1',
        });
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(res.body.runId === runA, 'expected same runId on idempotent retry');
        assert(res.body.generation === 1, 'expected unchanged generation on idempotent retry');
      });

      // --- 3. Concurrent claim on same working tree fails with LOCK_HELD ----
      const taskA2 = createTask(db, { title: 'Task A2', repoId: repoA.id, priority: 'P2' });
      await check(
        'claim: concurrent claim on same working tree fails with 409 LOCK_HELD',
        async () => {
          const res = await post(`/internal/v1/tasks/${taskA2.id}/claim`, 'engine', {
            ownerId: 'owner-2',
            generation: 0,
            idempotencyKey: 'key-2',
          });
          assert(
            res.status === 409,
            `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`,
          );
          assert(res.body.code === 'LOCK_HELD', `expected LOCK_HELD, got ${res.body.code}`);
        },
      );

      // --- 4. Claim on a different working tree succeeds concurrently -------
      const taskB = createTask(db, { title: 'Task B', repoId: repoB.id, priority: 'P2' });
      let runB = '';
      await check(
        'claim: different working tree succeeds while another tree is locked',
        async () => {
          const res = await post(`/internal/v1/tasks/${taskB.id}/claim`, 'engine', {
            ownerId: 'owner-3',
            generation: 0,
            idempotencyKey: 'key-3',
          });
          assert(
            res.status === 200,
            `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
          );
          assert(
            res.body.generation === 1,
            `expected generation 1 for fresh tree, got ${res.body.generation}`,
          );
          runB = res.body.runId;
        },
      );

      // --- 5. Heartbeat fencing -------------------------------------------
      await check('heartbeat: succeeds when ownerId and generation match', async () => {
        const res = await post(`/internal/v1/runs/${runA}/heartbeat`, 'engine', {
          ownerId: 'owner-1',
          generation: 1,
        });
        assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(res.body.ok === true, 'expected ok:true');
      });

      await check('heartbeat: fails with 409 STALE_GENERATION on owner mismatch', async () => {
        const res = await post(`/internal/v1/runs/${runA}/heartbeat`, 'engine', {
          ownerId: 'wrong-owner',
          generation: 1,
        });
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(
          res.body.code === 'STALE_GENERATION',
          `expected STALE_GENERATION, got ${res.body.code}`,
        );
      });

      await check('heartbeat: fails with 409 STALE_GENERATION on generation mismatch', async () => {
        const res = await post(`/internal/v1/runs/${runA}/heartbeat`, 'engine', {
          ownerId: 'owner-1',
          generation: 99,
        });
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(
          res.body.code === 'STALE_GENERATION',
          `expected STALE_GENERATION, got ${res.body.code}`,
        );
      });

      // --- 6. Finalize requires verifiedStopped:true -----------------------
      await check(
        'finalize: verifiedStopped:false rejected with 400 VERIFIED_STOP_REQUIRED',
        async () => {
          const res = await post(`/internal/v1/runs/${runA}/finalize`, 'engine', {
            ownerId: 'owner-1',
            generation: 1,
            status: 'done',
            verifiedStopped: false,
          });
          assert(
            res.status === 400,
            `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`,
          );
          assert(
            res.body.code === 'VERIFIED_STOP_REQUIRED',
            `expected VERIFIED_STOP_REQUIRED, got ${res.body.code}`,
          );
        },
      );

      // --- 7. Finalize with stale generation rejected -----------------------
      await check('finalize: stale generation rejected with 409 STALE_GENERATION', async () => {
        const res = await post(`/internal/v1/runs/${runA}/finalize`, 'engine', {
          ownerId: 'owner-1',
          generation: 99,
          status: 'done',
          verifiedStopped: true,
          verificationMethod: 'process_group_empty',
        });
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(
          res.body.code === 'STALE_GENERATION',
          `expected STALE_GENERATION, got ${res.body.code}`,
        );
      });

      // --- 8. Finalize with verifiedStopped:true releases lock, updates task -
      await check('finalize: verifiedStopped:true releases lock and marks task done', async () => {
        const res = await post(`/internal/v1/runs/${runA}/finalize`, 'engine', {
          ownerId: 'owner-1',
          generation: 1,
          status: 'done',
          verifiedStopped: true,
          verificationMethod: 'process_group_empty',
          summary: 'All good',
        });
        assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

        const taskRow = db.query('SELECT status FROM tasks WHERE id = ?').get(taskA.id) as {
          status: string;
        };
        assert(taskRow.status === 'done', `expected task done, got ${taskRow.status}`);

        const lockRow = db
          .query('SELECT owner_run_id, generation FROM run_locks WHERE working_tree_key = ?')
          .get(repoA.canonicalPath) as { owner_run_id: string; generation: number };
        assert(lockRow.owner_run_id === '', 'expected lock released (empty owner_run_id)');
        assert(lockRow.generation === 1, 'expected generation unchanged by finalize');
      });

      // --- 9. Generation monotonicity: next claim increments, never resets --
      let runA3 = '';
      await check('claim: generation increments after release and never resets', async () => {
        const res = await post(`/internal/v1/tasks/${taskA2.id}/claim`, 'engine', {
          ownerId: 'owner-4',
          generation: 0,
          idempotencyKey: 'key-4',
        });
        assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(
          res.body.generation === 2,
          `expected generation 2 after release, got ${res.body.generation}`,
        );
        runA3 = res.body.runId;
      });

      // --- 10. Mark uncertain quarantines the lock --------------------------
      await check('mark-uncertain: sets run uncertain and quarantines lock', async () => {
        const res = await post(`/internal/v1/runs/${runA3}/mark-uncertain`, 'engine', {
          ownerId: 'owner-4',
          generation: 2,
          reason: 'lost heartbeat',
        });
        assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

        const runRow = db.query('SELECT status FROM runs WHERE id = ?').get(runA3) as {
          status: string;
        };
        assert(runRow.status === 'uncertain', `expected uncertain, got ${runRow.status}`);

        const lockRow = db
          .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
          .get(repoA.canonicalPath) as { quarantined: number };
        assert(lockRow.quarantined === 1, 'expected lock quarantined');
      });

      const taskA4 = createTask(db, { title: 'Task A4', repoId: repoA.id, priority: 'P2' });
      await check('claim: fails with 409 LOCK_HELD while quarantined', async () => {
        const res = await post(`/internal/v1/tasks/${taskA4.id}/claim`, 'engine', {
          ownerId: 'owner-5',
          generation: 0,
          idempotencyKey: 'key-5',
        });
        assert(res.status === 409, `expected 409, got ${res.status}`);
        assert(res.body.code === 'LOCK_HELD', `expected LOCK_HELD, got ${res.body.code}`);
      });

      // --- 11. Clear quarantine allows subsequent claim ----------------------
      await check('clear-quarantine: clears quarantine and allows subsequent claim', async () => {
        const clearRes = await post(`/internal/v1/runs/${runA3}/clear-quarantine`, 'supervisor', {
          operatorId: 'admin-1',
          reason: 'verified process tree gone',
        });
        assert(
          clearRes.status === 200,
          `expected 200, got ${clearRes.status}: ${JSON.stringify(clearRes.body)}`,
        );

        const lockRow = db
          .query('SELECT quarantined FROM run_locks WHERE working_tree_key = ?')
          .get(repoA.canonicalPath) as { quarantined: number };
        assert(lockRow.quarantined === 0, 'expected quarantine cleared');

        const claimRes = await post(`/internal/v1/tasks/${taskA4.id}/claim`, 'engine', {
          ownerId: 'owner-6',
          generation: 0,
          idempotencyKey: 'key-6',
        });
        assert(
          claimRes.status === 200,
          `expected 200, got ${claimRes.status}: ${JSON.stringify(claimRes.body)}`,
        );
        assert(
          claimRes.body.generation === 3,
          `expected generation 3, got ${claimRes.body.generation}`,
        );

        // Finalize so later checks (restart etc.) leave no dangling active run.
        const finalizeRes = await post(
          `/internal/v1/runs/${claimRes.body.runId}/finalize`,
          'engine',
          {
            ownerId: 'owner-6',
            generation: 3,
            status: 'done',
            verifiedStopped: true,
            verificationMethod: 'process_group_empty',
          },
        );
        assert(finalizeRes.status === 200, 'expected finalize of taskA4 run to succeed');
      });

      // --- 12. Explicit retry: clear vs quarantined ---------------------------
      await check('retry: succeeds when lock is clear', async () => {
        db.query("UPDATE tasks SET status = 'error', blocked_reason = 'boom' WHERE id = ?").run(
          taskB.id,
        );
        const retried = retryTask(db, taskB.id);
        assert(retried.status === 'todo', `expected todo, got ${retried.status}`);
        assert(retried.blockedReason === null, 'expected blockedReason cleared');
      });

      await check('retry: rejected with 409 LOCK_HELD when working tree quarantined', async () => {
        db.query(
          `UPDATE run_locks
           SET quarantined = 1, quarantined_reason = 'test quarantine', quarantined_at = ?, updated_at = ?
           WHERE working_tree_key = ?`,
        ).run(new Date().toISOString(), new Date().toISOString(), repoB.canonicalPath);

        db.query(
          "UPDATE tasks SET status = 'error', blocked_reason = 'boom again' WHERE id = ?",
        ).run(taskB.id);

        let threw = false;
        try {
          retryTask(db, taskB.id);
        } catch (err) {
          threw = true;
          assert(
            (err as { code?: string }).code === 'LOCK_HELD',
            'expected LOCK_HELD domain error',
          );
        }
        assert(threw, 'expected retry to throw while quarantined');

        db.query('UPDATE run_locks SET quarantined = 0 WHERE working_tree_key = ?').run(
          repoB.canonicalPath,
        );
      });

      // --- 13. Runnable candidates ordered by priority ------------------------
      await check('runnable: returns tasks ordered by priority then enqueued_at', async () => {
        const repoC = createRepository(db, {
          name: 'repo-c',
          displayPath: (() => {
            const dirC = join(reposDir, 'repo-c');
            mkdirSync(dirC, { recursive: true });
            return dirC;
          })(),
          defaultProvider: 'codex',
        });
        const p3 = createTask(db, { title: 'Low priority', repoId: repoC.id, priority: 'P3' });
        const p0 = createTask(db, { title: 'High priority', repoId: repoC.id, priority: 'P0' });
        const p1 = createTask(db, { title: 'Mid priority', repoId: repoC.id, priority: 'P1' });
        void p3;

        const res = await get('/internal/v1/tasks/runnable', 'engine');
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const ids = (res.body as { id: string; priority: string; repoId: string }[])
          .filter((t) => t.repoId === repoC.id || [p0.id, p1.id].includes(t.id))
          .map((t) => t.id);
        const indexP0 = ids.indexOf(p0.id);
        const indexP1 = ids.indexOf(p1.id);
        assert(indexP0 !== -1 && indexP1 !== -1, 'expected seeded tasks in runnable list');
        assert(indexP0 < indexP1, 'expected P0 task before P1 task');
      });

      // --- 14. Task context returns task, repo and message history -----------
      await check('context: returns task, repository, and message history', async () => {
        appendMessage(db, taskB.conversationId, { content: 'hello from context check' }, 'user');
        const res = await get(`/internal/v1/tasks/${taskB.id}/context`, 'engine');
        assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(res.body.task.id === taskB.id, 'expected task in context');
        assert(res.body.repository.id === repoB.id, 'expected repository in context');
        assert(Array.isArray(res.body.messages), 'expected messages array');
        assert(res.body.messages.length >= 1, 'expected at least one message');
      });

      // --- 15. Not-found paths ------------------------------------------------
      await check('claim: unknown task returns 404 NOT_FOUND', async () => {
        const res = await post('/internal/v1/tasks/does-not-exist/claim', 'engine', {
          ownerId: 'owner-x',
          generation: 0,
          idempotencyKey: 'key-x',
        });
        assert(res.status === 404, `expected 404, got ${res.status}`);
        assert(res.body.code === 'NOT_FOUND', `expected NOT_FOUND, got ${res.body.code}`);
      });

      await check('heartbeat: unknown run returns 404 NOT_FOUND', async () => {
        const res = await post('/internal/v1/runs/does-not-exist/heartbeat', 'engine', {
          ownerId: 'owner-x',
          generation: 0,
        });
        assert(res.status === 404, `expected 404, got ${res.status}`);
        assert(res.body.code === 'NOT_FOUND', `expected NOT_FOUND, got ${res.body.code}`);
      });

      // --- 16. Clear-quarantine is supervisor-only ---------------------------
      await check('clear-quarantine: rejected for engine role with 403', async () => {
        const res = await post(`/internal/v1/runs/${runA}/clear-quarantine`, 'engine', {
          operatorId: 'admin-2',
          reason: 'should be denied',
        });
        assert(res.status === 403, `expected 403, got ${res.status}`);
      });
    }
  } finally {
    closeDatabase(db);
    rmSync(workDir, { recursive: true, force: true });
  }

  for (const result of results) {
    const marker = result.passed ? 'PASS' : 'FAIL';
    console.log(`[${marker}] ${result.name}${result.error ? ` — ${result.error}` : ''}`);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
