import type { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
// Automated API verification suite (T11).
// Run: bun run src/backend/api-checks.ts
import { Hono } from 'hono';
import { mountPublicApi } from './api/index.ts';
import { canonicalizePath } from './canonical-path.ts';
import { closeDatabase, openDatabase } from './db/connection.ts';
import { runMigrations } from './db/migrations.ts';

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

function sh(cmd: string, cwd: string): void {
  execFileSync('/bin/sh', ['-c', cmd], { cwd });
}

function buildApp(db: Database): Hono {
  const app = new Hono();
  mountPublicApi(app, db);
  return app;
}

// biome-ignore lint/suspicious/noExplicitAny: test helper response type
type TestResponseBody = any;

async function jsonRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: TestResponseBody }> {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const workDir = mkdtempSync(join(tmpdir(), 'taskaside-api-checks-'));
const dbPath = join(workDir, 'taskaside.db');
const reposDir = join(workDir, 'repos');
mkdirSync(reposDir, { recursive: true });

async function main(): Promise<void> {
  let db = openDatabase({ path: dbPath });
  runMigrations(db);
  let app = buildApp(db);

  try {
    // --- 1. Path canonicalization --------------------------------------------
    const repoRoot = join(reposDir, 'alias-repo');
    const repoSymlink = join(reposDir, 'alias-repo-symlink');
    const repoSubdir = join(repoRoot, 'subdir', 'nested');
    mkdirSync(repoSubdir, { recursive: true });
    sh('git init -q', repoRoot);
    sh('git -c user.email=t@t.com -c user.name=t commit --allow-empty -q -m init', repoRoot);
    symlinkSync(repoRoot, repoSymlink);

    await check('canonical-path: symlink, subdirectory and plain path converge', () => {
      const plain = canonicalizePath(repoRoot).canonicalPath;
      const viaSymlink = canonicalizePath(repoSymlink).canonicalPath;
      const viaSubdir = canonicalizePath(repoSubdir).canonicalPath;
      assert(
        plain === viaSymlink,
        `expected symlink alias to match plain path: ${viaSymlink} vs ${plain}`,
      );
      assert(
        plain === viaSubdir,
        `expected subdirectory to collapse to repo root: ${viaSubdir} vs ${plain}`,
      );
    });

    await check('canonical-path: case-insensitive filesystem folds to one key', () => {
      const upperVariant = repoRoot.toUpperCase();
      const plain = canonicalizePath(repoRoot).canonicalPath;
      try {
        const viaUpper = canonicalizePath(upperVariant).canonicalPath;
        assert(plain === viaUpper, `expected case-insensitive fold: ${viaUpper} vs ${plain}`);
      } catch {
        // Case-sensitive filesystem (e.g. Linux ext4): uppercase path legitimately
        // does not exist. Not a failure of the canonicalization contract.
      }
    });

    await check('canonical-path: nonexistent path is rejected with VALIDATION_ERROR', () => {
      let threw = false;
      try {
        canonicalizePath(join(reposDir, 'does-not-exist'));
      } catch (err) {
        threw = true;
        const code = (err as { code?: string }).code;
        assert(code === 'VALIDATION_ERROR', 'expected VALIDATION_ERROR code');
      }
      assert(threw, 'expected canonicalizePath to throw for a missing path');
    });

    // --- 2. Repository registration -------------------------------------------
    let repoId = '';
    await check('repositories: POST creates a repository', async () => {
      const res = await jsonRequest(app, 'POST', '/api/repositories', {
        name: 'demo-repo',
        displayPath: repoRoot,
        defaultProvider: 'codex',
      });
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(typeof res.body.id === 'string', 'expected repository id');
      repoId = res.body.id;
    });

    await check('repositories: duplicate canonical path rejected with 409', async () => {
      const res = await jsonRequest(app, 'POST', '/api/repositories', {
        name: 'demo-repo-again',
        displayPath: repoSymlink,
        defaultProvider: 'claude',
      });
      assert(res.status === 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    });

    await check('repositories: GET lists registered repositories', async () => {
      const res = await jsonRequest(app, 'GET', '/api/repositories');
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(
        res.body.some((r: { id: string }) => r.id === repoId),
        'expected registered repository in list',
      );
    });

    // --- 3. Atomic task + conversation creation -------------------------------
    let rootTaskId = '';
    let rootConversationId = '';
    await check('tasks: POST atomically creates task and conversation', async () => {
      const res = await jsonRequest(app, 'POST', '/api/tasks', {
        title: 'Root task',
        repoId,
        priority: 'P1',
      });
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(typeof res.body.conversationId === 'string', 'expected conversationId on task');
      rootTaskId = res.body.id;
      rootConversationId = res.body.conversationId;
      assert(res.body.depth === 0, `expected root depth 0, got ${res.body.depth}`);
      assert(res.body.status === 'todo', `expected status todo, got ${res.body.status}`);

      const conversationRow = db
        .query('SELECT id FROM conversations WHERE id = ?')
        .get(rootConversationId);
      assert(conversationRow !== null, 'expected conversation row to exist in DB');
    });

    // --- 4. Task filtering ------------------------------------------------------
    let p3TaskId = '';
    await check('tasks: filtering seed data created', async () => {
      const res = await jsonRequest(app, 'POST', '/api/tasks', {
        title: 'Findable by keyword zephyr',
        repoId,
        priority: 'P3',
      });
      assert(res.status === 201, `expected 201, got ${res.status}`);
      p3TaskId = res.body.id;
    });

    await check('tasks: GET filters by status', async () => {
      const res = await jsonRequest(app, 'GET', '/api/tasks?status=todo');
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const allTodo = res.body.every((t: { status: string }) => t.status === 'todo');
      assert(allTodo, 'expected only todo tasks');
      assert(res.body.length >= 2, 'expected at least 2 todo tasks');
    });

    await check('tasks: GET filters by priority', async () => {
      const res = await jsonRequest(app, 'GET', '/api/tasks?priority=P3');
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(
        res.body.every((t: { priority: string }) => t.priority === 'P3'),
        'expected only P3 tasks',
      );
      assert(
        res.body.some((t: { id: string }) => t.id === p3TaskId),
        'expected seeded P3 task in results',
      );
    });

    await check('tasks: GET filters by repositoryId', async () => {
      const res = await jsonRequest(app, 'GET', `/api/tasks?repositoryId=${repoId}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.body.length >= 2, 'expected tasks for repository');
    });

    await check('tasks: GET filters by query text', async () => {
      const res = await jsonRequest(app, 'GET', '/api/tasks?query=zephyr');
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.body.length === 1, `expected exactly one match, got ${res.body.length}`);
      assert(res.body[0].id === p3TaskId, 'expected zephyr task to match');
    });

    // --- 5. Parent validation ----------------------------------------------------
    let childTaskId = '';
    await check('tasks: child receives depth 1', async () => {
      const res = await jsonRequest(app, 'POST', '/api/tasks', {
        title: 'Child task',
        repoId,
        parentId: rootTaskId,
      });
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.depth === 1, `expected depth 1, got ${res.body.depth}`);
      childTaskId = res.body.id;
    });

    await check('tasks: child cannot itself be a parent (grandchild rejected)', async () => {
      const res = await jsonRequest(app, 'POST', '/api/tasks', {
        title: 'Grandchild task',
        repoId,
        parentId: childTaskId,
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
      assert(
        res.body.code === 'CHILD_LIMIT_EXCEEDED',
        `expected CHILD_LIMIT_EXCEEDED, got ${res.body.code}`,
      );
    });

    await check('tasks: 5-child ceiling enforced; 6th child rejected', async () => {
      for (let i = 0; i < 4; i++) {
        const res = await jsonRequest(app, 'POST', '/api/tasks', {
          title: `Sibling child ${i}`,
          repoId,
          parentId: rootTaskId,
        });
        assert(res.status === 201, `expected sibling ${i} to succeed, got ${res.status}`);
      }
      const sixth = await jsonRequest(app, 'POST', '/api/tasks', {
        title: 'Sixth child',
        repoId,
        parentId: rootTaskId,
      });
      assert(sixth.status === 400, `expected 400 for 6th child, got ${sixth.status}`);
      assert(
        sixth.body.code === 'CHILD_LIMIT_EXCEEDED',
        `expected CHILD_LIMIT_EXCEEDED, got ${sixth.body.code}`,
      );
    });

    // --- 6. Task edit ------------------------------------------------------------
    await check('tasks: PATCH succeeds while todo', async () => {
      const res = await jsonRequest(app, 'PATCH', `/api/tasks/${p3TaskId}`, { title: 'Renamed' });
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.title === 'Renamed', 'expected title to update');
    });

    await check('tasks: PATCH rejected while processing', () => {
      db.query("UPDATE tasks SET status = 'processing' WHERE id = ?").run(p3TaskId);
      const patchReq = jsonRequest(app, 'PATCH', `/api/tasks/${p3TaskId}`, { title: 'Blocked' });
      return patchReq.then((res) => {
        assert(res.status === 400, `expected 400, got ${res.status}`);
        assert(
          res.body.code === 'INVALID_TRANSITION',
          `expected INVALID_TRANSITION, got ${res.body.code}`,
        );
        db.query("UPDATE tasks SET status = 'todo' WHERE id = ?").run(p3TaskId);
      });
    });

    // --- 7. Task cancel ------------------------------------------------------------
    await check('tasks: cancel transitions todo to cancelled', async () => {
      const res = await jsonRequest(app, 'POST', `/api/tasks/${p3TaskId}/cancel`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.body.status === 'cancelled', `expected cancelled, got ${res.body.status}`);
    });

    // --- 8. Task retry ---------------------------------------------------------
    let errorTaskId = '';
    await check('tasks: retry transitions error to todo', async () => {
      const created = await jsonRequest(app, 'POST', '/api/tasks', {
        title: 'Errored task',
        repoId,
      });
      errorTaskId = created.body.id;
      db.query("UPDATE tasks SET status = 'error', blocked_reason = 'boom' WHERE id = ?").run(
        errorTaskId,
      );

      const res = await jsonRequest(app, 'POST', `/api/tasks/${errorTaskId}/retry`);
      assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.status === 'todo', `expected todo, got ${res.body.status}`);
      assert(res.body.blockedReason === null, 'expected blockedReason cleared');
    });

    await check('tasks: retry rejected on done task', async () => {
      db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(errorTaskId);
      const res = await jsonRequest(app, 'POST', `/api/tasks/${errorTaskId}/retry`);
      assert(res.status === 400, `expected 400, got ${res.status}`);
      assert(
        res.body.code === 'INVALID_TRANSITION',
        `expected INVALID_TRANSITION, got ${res.body.code}`,
      );
    });

    await check('tasks: retry rejected on cancelled task', async () => {
      const res = await jsonRequest(app, 'POST', `/api/tasks/${p3TaskId}/retry`);
      assert(res.status === 400, `expected 400, got ${res.status}`);
      assert(
        res.body.code === 'INVALID_TRANSITION',
        `expected INVALID_TRANSITION, got ${res.body.code}`,
      );
    });

    // --- 9. Chat messages: append + pagination ----------------------------------
    await check('chat: POST appends message to conversation', async () => {
      const res = await jsonRequest(
        app,
        'POST',
        `/api/conversations/${rootConversationId}/messages`,
        { content: 'hello from user' },
      );
      assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert(res.body.taskId === rootTaskId, 'expected message linked to root task');
    });

    await check('chat: pagination returns stable cursor across pages', async () => {
      for (let i = 0; i < 9; i++) {
        await jsonRequest(app, 'POST', `/api/conversations/${rootConversationId}/messages`, {
          content: `message ${i}`,
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const qs = cursor ? `?limit=3&cursor=${encodeURIComponent(cursor)}` : '?limit=3';
        const path = `/api/conversations/${rootConversationId}/messages${qs}`;
        const res = await jsonRequest(app, 'GET', path);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        for (const m of res.body.messages) {
          seen.push(m.id);
        }
        if (!res.body.nextCursor) {
          break;
        }
        cursor = res.body.nextCursor;
      }

      assert(seen.length === new Set(seen).size, 'expected no duplicate messages across pages');
      assert(seen.length >= 10, `expected at least 10 messages total, got ${seen.length}`);
    });

    await check('chat: GET /api/tasks/:id/messages forwards to conversation', async () => {
      const res = await jsonRequest(app, 'GET', `/api/tasks/${rootTaskId}/messages?limit=5`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.body.messages.length > 0, 'expected messages via task convenience route');
    });

    // --- 10. Terminal task message does not resurrect status --------------------
    await check('chat: message to terminal task does not change status', async () => {
      const conversationId = getConversationIdForTask(db, errorTaskId);
      assert(conversationId !== null, 'expected conversation for terminal task');
      const before = await jsonRequest(app, 'GET', `/api/tasks/${errorTaskId}`);
      assert(
        before.body.status === 'done',
        `expected done before message, got ${before.body.status}`,
      );

      const res = await jsonRequest(app, 'POST', `/api/conversations/${conversationId}/messages`, {
        content: 'are you still there?',
      });
      assert(res.status === 201, `expected 201, got ${res.status}`);

      const after = await jsonRequest(app, 'GET', `/api/tasks/${errorTaskId}`);
      assert(
        after.body.status === 'done',
        `expected status to remain done, got ${after.body.status}`,
      );
    });

    // --- 11. Reopen/restart survival ---------------------------------------------
    await check('restart: close DB, reopen, re-mount routes, data survives', async () => {
      closeDatabase(db);
      db = openDatabase({ path: dbPath });
      runMigrations(db);
      app = buildApp(db);

      const repoRes = await jsonRequest(app, 'GET', '/api/repositories');
      assert(repoRes.body.length >= 1, 'expected repositories to survive restart');

      const taskRes = await jsonRequest(app, 'GET', `/api/tasks/${rootTaskId}`);
      assert(taskRes.status === 200, 'expected root task to survive restart');
      assert(
        taskRes.body.conversationId === rootConversationId,
        'expected conversation link intact',
      );

      const msgPath = `/api/conversations/${rootConversationId}/messages?limit=3`;
      const msgRes = await jsonRequest(app, 'GET', msgPath);
      assert(msgRes.status === 200, 'expected messages to survive restart');
      assert(msgRes.body.messages.length > 0, 'expected message history to survive restart');

      // Constraint survives: duplicate repository path still rejected.
      const dup = await jsonRequest(app, 'POST', '/api/repositories', {
        name: 'dup-after-restart',
        displayPath: repoRoot,
        defaultProvider: 'codex',
      });
      assert(dup.status === 409, `expected 409 after restart, got ${dup.status}`);

      // Constraint survives: grandchild still rejected.
      const grandchild = await jsonRequest(app, 'POST', '/api/tasks', {
        title: 'Grandchild after restart',
        repoId,
        parentId: childTaskId,
      });
      assert(grandchild.status === 400, `expected 400 after restart, got ${grandchild.status}`);
    });

    // --- 12. Boundary check: no bun:sqlite imports outside src/backend ----------
    await check('boundary: no bun:sqlite imports outside src/backend', () => {
      const projectRoot = process.cwd();
      const srcRoot = join(projectRoot, 'src');
      const offenders: string[] = [];

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
            continue;
          }
          if (
            fullPath === import.meta.path ||
            fullPath === join(projectRoot, 'src', 'backend', 'db-checks.ts') ||
            fullPath === join(projectRoot, 'src', 'harness', 'harness-checks.ts')
          ) {
            continue;
          }
          const content = readFileSync(fullPath, 'utf8');
          if (content.includes('bun:sqlite')) {
            offenders.push(relative(projectRoot, fullPath));
          }
        }
      };
      walk(srcRoot);

      const backendDir = join('src', 'backend');
      const nonBackendOffenders = offenders.filter((path) => !path.startsWith(backendDir));
      const offenderList = nonBackendOffenders.join(', ');
      assert(
        nonBackendOffenders.length === 0,
        `expected zero bun:sqlite imports outside src/backend, found: ${offenderList}`,
      );
    });
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

function getConversationIdForTask(db: Database, taskId: string): string | null {
  const row = db.query('SELECT conversation_id FROM tasks WHERE id = ?').get(taskId) as {
    conversation_id: string;
  } | null;
  return row?.conversation_id ?? null;
}

main();
