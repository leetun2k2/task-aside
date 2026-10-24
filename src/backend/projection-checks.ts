// Automated verification suite for T15: Browser projection, Settings, and SSE (SPECIFICATION.md §3, §6, §8.1; ARCHITECTURE.md §2.1, §2.4, §7; TASKS.md T15).
// Run: bun run src/backend/projection-checks.ts
import type { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Hono } from 'hono';
import {
  type BrowserEvent,
  EventHub,
  type HubEvent,
  closeDatabase,
  createRepository,
  createTask,
  eventHub,
  getSettings,
  initializeDatabase,
  mountPublicApi,
  openDatabase,
} from './index.ts';

type CheckResult = { name: string; passed: boolean; error?: string };
const results: CheckResult[] = [];

function assert(condition: boolean, message: string): asserts condition {
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

// biome-ignore lint/suspicious/noExplicitAny: test response type
type TestResponseBody = any;

async function request(
  app: Hono,
  method: string,
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    token?: string;
  } = {},
): Promise<{ status: number; body: TestResponseBody; headers: Headers }> {
  const headers: Record<string, string> = {
    Host: '127.0.0.1:4000',
    Origin: 'http://127.0.0.1:4000',
    ...options.headers,
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await app.request(path, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const contentType = res.headers.get('content-type') ?? '';
  let body: TestResponseBody = null;
  if (contentType.includes('application/json')) {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } else {
    body = await res.text();
  }

  return { status: res.status, body, headers: res.headers };
}

const workDir = mkdtempSync(join(tmpdir(), 'taskaside-projection-checks-'));
const dbPath = join(workDir, 'taskaside.db');
const fakeStaticDir = join(workDir, 'dist-frontend');
mkdirSync(fakeStaticDir, { recursive: true });
mkdirSync(join(fakeStaticDir, 'assets'), { recursive: true });

// Create fake frontend build assets
writeFileSync(
  join(fakeStaticDir, 'index.html'),
  '<!DOCTYPE html><html><head><title>TaskAside</title></head><body><div id="root"></div></body></html>',
);
writeFileSync(join(fakeStaticDir, 'assets', 'index.js'), 'console.log("TaskAside");');
writeFileSync(join(fakeStaticDir, 'assets', 'index.css'), 'body { margin: 0; }');

const TEST_AUTH_TOKEN = 'test-auth-token-1234567890abcdef1234567890abcdef';
const TEST_INTERNAL_TOKEN = 'test-internal-token-1234567890abcdef1234567890abcdef';

process.env.TASKASIDE_AUTH_TOKEN = TEST_AUTH_TOKEN;
process.env.TASKASIDE_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

async function main(): Promise<void> {
  const db = initializeDatabase({ path: dbPath });

  try {
    const app = new Hono();
    mountPublicApi(app, db, {
      requireAuth: true,
      authToken: TEST_AUTH_TOKEN,
      staticDir: fakeStaticDir,
    });

    // --- 1. Browser Auth on Settings & Public Routes -------------------------
    await check('auth: GET /api/settings without token is rejected with 401', async () => {
      const res = await request(app, 'GET', '/api/settings');
      assert(res.status === 401, `expected 401, got ${res.status}`);
      assert(res.body.code === 'UNAUTHORIZED', 'expected code UNAUTHORIZED');
    });

    await check('auth: GET /api/settings with invalid token is rejected with 401', async () => {
      const res = await request(app, 'GET', '/api/settings', { token: 'invalid-token' });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await check('auth: GET /api/settings with internal.token is rejected with 403', async () => {
      const res = await request(app, 'GET', '/api/settings', { token: TEST_INTERNAL_TOKEN });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      assert(res.body.code === 'FORBIDDEN', 'expected code FORBIDDEN');
    });

    await check('auth: GET /api/settings with valid auth.token succeeds with 200', async () => {
      const res = await request(app, 'GET', '/api/settings', { token: TEST_AUTH_TOKEN });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.body.defaultProvider === 'codex', 'expected defaultProvider codex');
      assert(res.body.maxConcurrency === 8, 'expected maxConcurrency 8');
      assert(res.body.diagnostics !== undefined, 'expected diagnostics object');
      assert(res.body.diagnostics.service === 'backend', 'expected diagnostics service backend');
      assert(res.body.diagnostics.version === '0.1.0', 'expected version 0.1.0');
    });

    await check('auth: requireAuth protects /api/tasks when configured', async () => {
      const resUnauth = await request(app, 'GET', '/api/tasks');
      assert(resUnauth.status === 401, `expected 401 without auth, got ${resUnauth.status}`);

      const resAuth = await request(app, 'GET', '/api/tasks', { token: TEST_AUTH_TOKEN });
      assert(resAuth.status === 200, `expected 200 with auth, got ${resAuth.status}`);
    });

    // --- 2. Settings REST API: GET & PATCH -----------------------------------
    await check('settings: PATCH /api/settings updates provider and concurrency', async () => {
      const patchRes = await request(app, 'PATCH', '/api/settings', {
        token: TEST_AUTH_TOKEN,
        body: { defaultProvider: 'claude', maxConcurrency: 5 },
      });
      assert(patchRes.status === 200, `expected 200, got ${patchRes.status}`);
      assert(patchRes.body.defaultProvider === 'claude', 'expected provider updated to claude');
      assert(patchRes.body.maxConcurrency === 5, 'expected maxConcurrency updated to 5');

      const getRes = await request(app, 'GET', '/api/settings', { token: TEST_AUTH_TOKEN });
      assert(getRes.body.defaultProvider === 'claude', 'expected get to reflect claude');
      assert(getRes.body.maxConcurrency === 5, 'expected get to reflect 5');
    });

    await check(
      'settings: PATCH /api/settings with invalid provider rejects with 400',
      async () => {
        const res = await request(app, 'PATCH', '/api/settings', {
          token: TEST_AUTH_TOKEN,
          body: { defaultProvider: 'unsupported-provider' },
        });
        assert(res.status === 400, `expected 400, got ${res.status}`);
        assert(res.body.code === 'VALIDATION_ERROR', 'expected VALIDATION_ERROR');
      },
    );

    await check(
      'settings: PATCH /api/settings with out-of-range concurrency rejects with 400',
      async () => {
        const res = await request(app, 'PATCH', '/api/settings', {
          token: TEST_AUTH_TOKEN,
          body: { maxConcurrency: 99 },
        });
        assert(res.status === 400, `expected 400, got ${res.status}`);
        assert(res.body.code === 'VALIDATION_ERROR', 'expected VALIDATION_ERROR');
      },
    );

    await check('settings: PATCH /api/settings with empty body rejects with 400', async () => {
      const res = await request(app, 'PATCH', '/api/settings', {
        token: TEST_AUTH_TOKEN,
        body: {},
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
      assert(res.body.code === 'VALIDATION_ERROR', 'expected VALIDATION_ERROR');
    });

    // --- 3. Browser SSE Endpoint (/api/events) -------------------------------
    await check('sse: GET /api/events without token is rejected with 401', async () => {
      const res = await request(app, 'GET', '/api/events');
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await check('sse: GET /api/events with internal.token query is rejected with 403', async () => {
      const res = await request(app, 'GET', `/api/events?token=${TEST_INTERNAL_TOKEN}`);
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await check(
      'sse: GET /api/events with ?token=<auth.token> connects and receives connected event',
      async () => {
        const res = await app.request(`/api/events?token=${TEST_AUTH_TOKEN}`, {
          headers: {
            Host: '127.0.0.1:4000',
            Origin: 'http://127.0.0.1:4000',
          },
        });
        assert(res.status === 200, `expected 200, got ${res.status}`);
        assert(
          res.headers.get('content-type')?.includes('text/event-stream') === true,
          'expected text/event-stream content type',
        );

        const reader = res.body?.getReader();
        assert(reader !== undefined, 'expected readable stream');
        if (!reader) throw new Error('no reader');

        const chunk = await reader.read();
        assert(!chunk.done, 'expected first chunk');
        const text = new TextDecoder().decode(chunk.value);
        assert(text.includes('event: connected'), 'expected event: connected in initial chunk');
        assert(text.includes('"status":"connected"'), 'expected connected status');
        await reader.cancel();
      },
    );

    // --- 4. Post-Commit Event Fan-out & Monotonic Sequence -------------------
    await check('fanout: EventHub publishes events with monotonic IDs and entityVersion', () => {
      const initialSeq = eventHub.getGlobalSequence();

      let receivedEvent: HubEvent | null = null;
      const unsubscribe = eventHub.subscribe({
        id: 'test-subscriber',
        write: (e) => {
          receivedEvent = e;
        },
        close: () => {},
      });

      try {
        const published = eventHub.publish({
          type: 'task.status_changed',
          data: { taskId: 'task-123', status: 'processing', version: 2 },
        });

        assert(Number(published.id) === initialSeq + 1, 'expected monotonic increment');
        const ev = receivedEvent as HubEvent | null;
        assert(ev !== null, 'expected subscriber to receive event');
        assert(ev.event === 'task.status_changed', 'expected event type');
        assert(ev.data.entityVersion === initialSeq + 1, 'expected entityVersion');
      } finally {
        unsubscribe();
      }
    });

    await check('fanout: task state transitions increment version and publish to Hub', async () => {
      const fanoutRepoDir = join(workDir, 'fanout-repo');
      mkdirSync(fanoutRepoDir, { recursive: true });
      const repo = createRepository(db, {
        name: 'fanout-repo',
        displayPath: fanoutRepoDir,
        defaultProvider: 'codex',
      });

      const events: HubEvent[] = [];
      const unsub = eventHub.subscribe({
        id: 'fanout-check',
        write: (e) => {
          events.push(e);
        },
        close: () => {},
      });

      try {
        // Create task -> version 1
        const task = createTask(db, {
          title: 'Version test task',
          repoId: repo.id,
          priority: 'P2',
        });
        assert(task.version === 1, `expected initial version 1, got ${task.version}`);

        // Update task -> version 2
        const patchRes = await request(app, 'PATCH', `/api/tasks/${task.id}`, {
          token: TEST_AUTH_TOKEN,
          body: { title: 'Updated title' },
        });
        assert(patchRes.status === 200, `expected 200, got ${patchRes.status}`);
        assert(patchRes.body.version === 2, `expected version 2, got ${patchRes.body.version}`);

        // Cancel task -> version 3
        const cancelRes = await request(app, 'POST', `/api/tasks/${task.id}/cancel`, {
          token: TEST_AUTH_TOKEN,
        });
        assert(cancelRes.status === 200, `expected 200, got ${cancelRes.status}`);
        assert(cancelRes.body.version === 3, `expected version 3, got ${cancelRes.body.version}`);

        // Verify published events
        const taskEvents = events.filter((e) => e.data.taskId === task.id);
        assert(taskEvents.length >= 3, `expected at least 3 events, got ${taskEvents.length}`);
        assert(taskEvents[0].data.version === 1, 'expected event version 1');
        assert(taskEvents[1].data.version === 2, 'expected event version 2');
        assert(taskEvents[2].data.version === 3, 'expected event version 3');
      } finally {
        unsub();
      }
    });

    // --- 5. Bounded Clients & Slow Subscriber Protection --------------------
    await check('bounded: max concurrent clients enforcement', () => {
      const limitedHub = new EventHub({ maxClients: 2 });
      assert(limitedHub.canAcceptClient(), 'expected can accept initially');

      limitedHub.subscribe({ id: 'client-1', write: () => {}, close: () => {} });
      limitedHub.subscribe({ id: 'client-2', write: () => {}, close: () => {} });

      assert(!limitedHub.canAcceptClient(), 'expected capacity reached at 2');
      let threw = false;
      try {
        limitedHub.subscribe({ id: 'client-3', write: () => {}, close: () => {} });
      } catch (err: unknown) {
        threw = true;
        assert((err as Error).message === 'MAX_CLIENTS_EXCEEDED', 'expected MAX_CLIENTS_EXCEEDED');
      }
      assert(threw, 'expected subscribe to throw when capacity exceeded');
    });

    await check('bounded: slow subscriber buffer overflow disconnects subscriber', () => {
      const hub = new EventHub({ maxBufferPerClient: 2 });
      let queueLen = 0;
      let closed = false;

      hub.subscribe({
        id: 'slow-subscriber',
        getQueueLength: () => queueLen,
        write: () => {},
        close: () => {
          closed = true;
        },
      });

      assert(hub.getSubscriberCount() === 1, 'expected 1 subscriber');

      // Normal publish
      queueLen = 1;
      hub.publish({ type: 'task.status_changed', data: { test: 1 } });
      assert(!closed, 'expected not closed while within limit');

      // Overflow publish
      queueLen = 2; // reaches maxBufferPerClient
      hub.publish({ type: 'task.status_changed', data: { test: 2 } });
      assert(closed, 'expected slow subscriber to be closed');
      assert(hub.getSubscriberCount() === 0, 'expected subscriber removed from hub');
    });

    // --- 6. Static Asset Serving & Security Protections ----------------------
    await check('static: serves index.html at root /', async () => {
      const res = await request(app, 'GET', '/');
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.headers.get('content-type')?.includes('text/html') === true, 'expected text/html');
      assert(res.body.includes('<title>TaskAside</title>'), 'expected index.html content');
      assert(res.headers.get('x-content-type-options') === 'nosniff', 'expected nosniff header');
    });

    await check('static: serves static css and js assets', async () => {
      const jsRes = await request(app, 'GET', '/assets/index.js');
      assert(jsRes.status === 200, `expected 200, got ${jsRes.status}`);
      assert(
        jsRes.headers.get('content-type')?.includes('javascript') === true,
        'expected js type',
      );
      assert(jsRes.body.includes('TaskAside'), 'expected js content');

      const cssRes = await request(app, 'GET', '/assets/index.css');
      assert(cssRes.status === 200, `expected 200, got ${cssRes.status}`);
      assert(
        cssRes.headers.get('content-type')?.includes('text/css') === true,
        'expected css type',
      );
    });

    await check('static: SPA fallback serves index.html for navigation route', async () => {
      const res = await request(app, 'GET', '/tasks/some-task-id');
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.headers.get('content-type')?.includes('text/html') === true, 'expected text/html');
      assert(res.body.includes('<title>TaskAside</title>'), 'expected index.html content');
    });

    await check('static: path traversal attempt rejected with 403', async () => {
      const res = await request(app, 'GET', '/assets/..%2fpackage.json');
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await check('static: direct database file request is blocked with 403', async () => {
      const resDb = await request(app, 'GET', '/taskaside.db');
      assert(resDb.status === 403, `expected 403, got ${resDb.status}`);

      const resWal = await request(app, 'GET', '/taskaside.db-wal');
      assert(resWal.status === 403, `expected 403, got ${resWal.status}`);
    });

    await check('static: log file request is blocked with 403', async () => {
      const res = await request(app, 'GET', '/service.log');
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await check('static: source code request is blocked with 403', async () => {
      const res = await request(app, 'GET', '/src/backend/index.ts');
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    // --- 7. Data Persistence Across Reopen -----------------------------------
    await check('persistence: settings and task versions survive close/reopen', () => {
      closeDatabase(db);
      const reopenedDb = openDatabase({ path: dbPath });

      try {
        const settings = getSettings(reopenedDb);
        assert(settings.defaultProvider === 'claude', 'expected persisted claude provider');
        assert(settings.maxConcurrency === 5, 'expected persisted concurrency 5');

        const tasks = reopenedDb
          .query("SELECT version FROM tasks WHERE title = 'Updated title'")
          .all() as { version: number }[];
        assert(tasks.length > 0, 'expected task to exist');
        assert(tasks[0].version === 3, `expected persisted version 3, got ${tasks[0].version}`);
      } finally {
        closeDatabase(reopenedDb);
      }
    });

    // --- 8. Boundary: Zero bun:sqlite outside src/backend --------------------
    await check('boundary: zero bun:sqlite imports outside src/backend', () => {
      const rootDir = resolve(import.meta.dir, '../..');
      function scanDir(dir: string): void {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (
            entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === 'dist'
          ) {
            continue;
          }
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            if (
              fullPath === import.meta.path ||
              fullPath === join(rootDir, 'src', 'harness', 'harness-checks.ts') ||
              fullPath === join(rootDir, 'src', 'backend', 'db-checks.ts') ||
              fullPath === join(rootDir, 'src', 'backend', 'api-checks.ts')
            ) {
              continue;
            }
            const rel = relative(rootDir, fullPath);
            if (!rel.startsWith('src/backend')) {
              const content = readFileSync(fullPath, 'utf8');
              if (/from\s+['"]bun:sqlite['"]/.test(content)) {
                assert(false, `forbidden bun:sqlite import found in non-backend file: ${rel}`);
              }
            }
          }
        }
      }
      scanDir(rootDir);
    });
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // --- Summary -------------------------------------------------------------
  console.log('\nT15 Browser Projection & Settings Verification Suite:');
  let failed = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✓ ${r.name}`);
    } else {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.error}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} checks failed.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} checks passed successfully.`);
  }
}

function resolve(...segments: string[]): string {
  return join(...segments);
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
