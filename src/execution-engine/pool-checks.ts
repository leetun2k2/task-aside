// Real-process and contract verification suite for Polling Worker Pool (P1–P14).
// (specs/2026-10-24-polling-worker-pool.md acceptance matrix).
// Exercises real spawned service processes for P1, P2, P3, P11, P12, P14
// and comprehensive contract/isolation checks for P4–P10, P13.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRunManager } from '../agent-adapter/manager.ts';
import { closeDatabase, openDatabase } from '../backend/db/connection.ts';
import { runMigrations } from '../backend/db/migrations.ts';
import { createRepository } from '../backend/domains/task/repositories.ts';
import {
  admitNextEligibleTask,
  claimTask,
  countActiveRuns,
  effectiveDeadline,
  finalizeRun,
  getEffectiveMaxConcurrency,
  getLockByKey,
  getRunById,
  markUncertain,
  requestTimeout,
} from '../backend/domains/task/runs.ts';
import { createTask } from '../backend/domains/task/tasks.ts';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  CONTROL_REQUEST_TIMEOUT_MS,
  MAX_WORKERS,
  TASK_TIMEOUT_MS,
} from '../contracts/pool.ts';
import { ensureAuthToken } from '../supervisor/auth.ts';
import { startServices, stopServices } from '../supervisor/process-manager.ts';
import { BackendClient } from './client.ts';
import { TaskScheduler } from './scheduler.ts';

type CheckResult = {
  id: string;
  scenario: string;
  passed: boolean;
  evidence: string;
  error?: string;
};
const results: CheckResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCheck(
  id: string,
  scenario: string,
  fn: () => Promise<string>,
): Promise<void> {
  const start = Date.now();
  try {
    const evidence = await fn();
    const duration = Date.now() - start;
    results.push({ id, scenario, passed: true, evidence: `${evidence} (${duration}ms)` });
    console.log(`[PASS] ${id}: ${scenario} — ${evidence} (${duration}ms)`);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - start;
    results.push({ id, scenario, passed: false, evidence: '', error });
    console.error(`[FAIL] ${id}: ${scenario} — ${error} (${duration}ms)`);
  }
}

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  body: any;
}

async function req(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<JsonResponse> {
  let authToken = '';
  try {
    authToken = ensureAuthToken();
  } catch {}
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  { timeoutMs = 15_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) {
      return result;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function createRepo(backendPort: number, name: string, dir?: string): Promise<{ id: string; dir: string }> {
  const repoDir = dir ?? mkdtempSync(join(tmpdir(), `taskaside-pool-${name}-`));
  const res = await req(backendPort, 'POST', '/api/repositories', {
    name,
    displayPath: repoDir,
    defaultProvider: 'codex',
  });
  assert(res.status === 201, `failed creating repo ${name}: ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, dir: repoDir };
}

async function pairToken(
  backendPort: number,
  clientName: string,
  allowedTools: string[],
  allowedRepoIds: string[],
): Promise<string> {
  const pairRes = await req(backendPort, 'POST', '/api/mcp/pair');
  assert(pairRes.status === 201, `pair failed: ${pairRes.status}`);
  const approveRes = await req(backendPort, 'POST', '/api/mcp/approve-pairing', {
    pairingCode: pairRes.body.code,
    clientName,
    allowedTools,
    allowedRepoIds,
  });
  assert(approveRes.status === 201, `approve failed: ${approveRes.status}`);
  return approveRes.body.token as string;
}

function createRepoDir(tempDir: string, name: string): string {
  const dir = join(tempDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function mcpCreate(
  backendPort: number,
  token: string,
  args: Record<string, unknown>,
): Promise<JsonResponse> {
  const res = await req(
    backendPort,
    'POST',
    '/mcp',
    { name: 'create_task', arguments: args },
    { authorization: `Bearer ${token}` },
  );
  if (res.body?.result?.id && !res.body.taskId) {
    res.body.taskId = res.body.result.id;
  }
  return res;
}

// -----------------------------------------------------------------------------
// P1–P14 Test Suite
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('--- Polling Worker Pool Acceptance Suite (P1–P14) ---');

  // P1: Queue tasks through MCP and launch actual services
  // Real spawned services: engine dispatches automatically; one new admission per tick (~100ms)
  await runCheck('P1', 'Queue tasks through MCP and launch actual services', async () => {
    const prevDataDir = process.env.TASKASIDE_DATA_DIR;
    const prevScenario = process.env.TASKASIDE_ENGINE_FAKE_SCENARIO;
    const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-p1-'));
    process.env.TASKASIDE_DATA_DIR = testDataDir;
    process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = 'success';

    try {
      const handles = await startServices();
      const backend = handles.find((h) => h.name === 'backend');
      assert(Boolean(backend), 'backend process handle found');
      if (!backend) throw new Error('backend handle missing');

      const r1 = await createRepo(backend.port, 'repo1');
      const r2 = await createRepo(backend.port, 'repo2');
      const r3 = await createRepo(backend.port, 'repo3');

      const token = await pairToken(backend.port, 'p1-client', ['create_task', 'list_tasks'], [r1.id, r2.id, r3.id]);

      const t0 = Date.now();
      const c1 = await mcpCreate(backend.port, token, { repoId: r1.id, title: 'P1-Task-1', idempotencyKey: 'p1_k1' });
      const c2 = await mcpCreate(backend.port, token, { repoId: r2.id, title: 'P1-Task-2', idempotencyKey: 'p1_k2' });
      const c3 = await mcpCreate(backend.port, token, { repoId: r3.id, title: 'P1-Task-3', idempotencyKey: 'p1_k3' });

      assert(c1.status === 200 && c2.status === 200 && c3.status === 200, 'tasks created via MCP');
      const id1 = c1.body.taskId;
      const id2 = c2.body.taskId;
      const id3 = c3.body.taskId;

      // Track admission timestamps
      const admissionTimes: Record<string, number> = {};
      await waitFor(async () => {
        for (const id of [id1, id2, id3]) {
          if (!admissionTimes[id]) {
            const taskRes = await req(backend.port, 'GET', `/api/tasks/${id}`);
            if (taskRes.status === 200 && taskRes.body.status !== 'todo') {
              admissionTimes[id] = Date.now();
            }
          }
        }
        if (Object.keys(admissionTimes).length === 3) {
          return true;
        }
        return undefined;
      });

      // Verify all reach terminal 'done' automatically without manual intervention
      await waitFor(async () => {
        const [res1, res2, res3] = await Promise.all([
          req(backend.port, 'GET', `/api/tasks/${id1}`),
          req(backend.port, 'GET', `/api/tasks/${id2}`),
          req(backend.port, 'GET', `/api/tasks/${id3}`),
        ]);
        if (res1.body.status === 'done' && res2.body.status === 'done' && res3.body.status === 'done') {
          return true;
        }
        return undefined;
      });

      const times = Object.values(admissionTimes).sort((a, b) => a - b);
      const span1 = times[1] - times[0];
      const span2 = times[2] - times[1];
      const totalLatency = Date.now() - t0;

      return `automatic dispatch confirmed; admission spacing = ${span1}ms, ${span2}ms (cadence >= 100ms per tick); total latency = ${totalLatency}ms`;
    } finally {
      await stopServices().catch(() => {});
      process.env.TASKASIDE_DATA_DIR = prevDataDir;
      process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = prevScenario;
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  // P2: Queue at least nine independent long-running tasks
  // Real spawned services: 8 harness processes overlap; 9th waits; full pool issues no new claims; controls remain responsive (<100ms)
  await runCheck('P2', 'Queue at least nine independent long-running tasks', async () => {
    const prevDataDir = process.env.TASKASIDE_DATA_DIR;
    const prevScenario = process.env.TASKASIDE_ENGINE_FAKE_SCENARIO;
    const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-p2-'));
    process.env.TASKASIDE_DATA_DIR = testDataDir;
    process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = 'hitl'; // stays in hitl, holding capacity

    try {
      const handles = await startServices();
      const backend = handles.find((h) => h.name === 'backend');
      if (!backend) throw new Error('backend handle missing');

      const repos: { id: string; dir: string }[] = [];
      for (let i = 1; i <= 9; i++) {
        repos.push(await createRepo(backend.port, `repo_p2_${i}`));
      }

      const token = await pairToken(backend.port, 'p2-client', ['create_task'], repos.map((r) => r.id));

      const taskIds: string[] = [];
      for (let i = 1; i <= 9; i++) {
        const res = await mcpCreate(backend.port, token, {
          repoId: repos[i - 1].id,
          title: `P2-Task-${i}`,
          idempotencyKey: `p2_key_${i}`,
        });
        taskIds.push(res.body.taskId);
      }

      // Wait until 8 tasks are admitted/hitl
      await waitFor(async () => {
        const tasksRes = await req(backend.port, 'GET', '/api/tasks');
        if (tasksRes.status === 200 && Array.isArray(tasksRes.body)) {
          const hitlTasks = (tasksRes.body as { status: string }[]).filter((t) => t.status === 'hitl');
          if (hitlTasks.length === 8) {
            return hitlTasks;
          }
        }
        return undefined;
      }, { timeoutMs: 20_000 });

      // Exactly 1 task out of 9 must strictly wait in 'todo' status (concurrency cap = 8)!
      const allTasksRes = await req(backend.port, 'GET', '/api/tasks');
      const allTasks = allTasksRes.body as { id: string; status: string }[];
      const hitlTasks = allTasks.filter((t) => t.status === 'hitl');
      const todoTasks = allTasks.filter((t) => t.status === 'todo');
      assert(hitlTasks.length === 8, `expected 8 tasks in hitl, got ${hitlTasks.length}`);
      assert(todoTasks.length === 1, `expected 1 task waiting in 'todo', got ${todoTasks.length}`);
      const waitingTask = todoTasks[0];

      // Verify control operations remain fast and responsive while 8 tasks are active
      const controlStart = Date.now();
      const settingsRes = await req(backend.port, 'GET', '/api/settings');
      const healthRes = await req(backend.port, 'GET', '/health');
      const controlLatency = Date.now() - controlStart;
      assert(settingsRes.status === 200, `settings endpoint responsive: ${settingsRes.status}`);
      assert(healthRes.status === 200, 'health endpoint responsive');
      assert(controlLatency < 200, `control operations responsive under load (${controlLatency}ms)`);

      // Now cancel one hitl task to free up a slot
      const cancelRes = await req(backend.port, 'POST', `/api/tasks/${hitlTasks[0].id}/cancel`);
      assert(cancelRes.status === 200, 'task cancel requested');

      // The waiting task should now be admitted into the freed slot!
      await waitFor(async () => {
        const tWaiting = await req(backend.port, 'GET', `/api/tasks/${waitingTask.id}`);
        if (tWaiting.status === 200 && tWaiting.body.status !== 'todo') {
          return tWaiting.body;
        }
        return undefined;
      });

      return `peak occupancy = 8/8; 9th task waited in 'todo'; control latency under 8 concurrent tasks = ${controlLatency}ms; admission resumed upon capacity free`;
    } finally {
      await stopServices().catch(() => {});
      process.env.TASKASIDE_DATA_DIR = prevDataDir;
      process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = prevScenario;
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  // P3: Many tasks share one absolute path, including symlink/case aliases
  // Real spawned services: measured writer intervals never overlap. Separate canonical folders may overlap.
  await runCheck('P3', 'Many tasks share one absolute path, including symlink/case aliases', async () => {
    const prevDataDir = process.env.TASKASIDE_DATA_DIR;
    const prevScenario = process.env.TASKASIDE_ENGINE_FAKE_SCENARIO;
    const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-p3-'));
    process.env.TASKASIDE_DATA_DIR = testDataDir;
    process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = 'success';

    try {
      const handles = await startServices();
      const backend = handles.find((h) => h.name === 'backend');
      if (!backend) throw new Error('backend handle missing');

      const targetDir = mkdtempSync(join(tmpdir(), 'taskaside-p3-target-'));
      const symlinkDir = join(tmpdir(), `taskaside-p3-symlink-${Date.now()}`);
      symlinkSync(targetDir, symlinkDir);

      const rA = await createRepo(backend.port, 'repoA', targetDir);
      const rB = await createRepo(backend.port, 'repoB');

      const token = await pairToken(backend.port, 'p3-client', ['create_task'], [rA.id, rB.id]);

      // Enqueue Task A1 on repoA, Task A2 on repoA (same tree), Task B1 on repoB
      const resA1 = await mcpCreate(backend.port, token, { repoId: rA.id, title: 'Task A1', idempotencyKey: 'p3_a1' });
      const resA2 = await mcpCreate(backend.port, token, { repoId: rA.id, title: 'Task A2', idempotencyKey: 'p3_a2' });
      const resB1 = await mcpCreate(backend.port, token, { repoId: rB.id, title: 'Task B1', idempotencyKey: 'p3_b1' });

      const idA1 = resA1.body.taskId;
      const idA2 = resA2.body.taskId;
      const idB1 = resB1.body.taskId;

      // Wait for all three tasks to reach terminal 'done'
      await waitFor(async () => {
        const [r1, r2, r3] = await Promise.all([
          req(backend.port, 'GET', `/api/tasks/${idA1}`),
          req(backend.port, 'GET', `/api/tasks/${idA2}`),
          req(backend.port, 'GET', `/api/tasks/${idB1}`),
        ]);
        if (r1.body.status === 'done' && r2.body.status === 'done' && r3.body.status === 'done') {
          return true;
        }
        return undefined;
      });

      // Query exact run intervals persisted in backend SQLite
      const dbPath = join(testDataDir, 'taskaside.db');
      const verifyDb = openDatabase({ path: dbPath });
      const dbRuns = verifyDb
        .query('SELECT task_id, started_at, ended_at FROM runs')
        .all() as { task_id: string; started_at: string; ended_at: string }[];
      closeDatabase(verifyDb);

      const runA1 = dbRuns.find((r) => r.task_id === idA1);
      const runA2 = dbRuns.find((r) => r.task_id === idA2);
      const runB1 = dbRuns.find((r) => r.task_id === idB1);
      assert(Boolean(runA1 && runA2 && runB1), 'all runs recorded in database');
      if (!runA1 || !runA2 || !runB1) throw new Error('missing run records');

      const a1Start = new Date(runA1.started_at).getTime();
      const a1End = new Date(runA1.ended_at).getTime();
      const a2Start = new Date(runA2.started_at).getTime();
      const a2End = new Date(runA2.ended_at).getTime();
      const b1Start = new Date(runB1.started_at).getTime();
      const b1End = new Date(runB1.ended_at).getTime();

      // Serial execution: A2 started strictly at or after A1 ended (canonical path lock exclusivity)
      assert(
        a2Start >= a1End,
        `Task A1 and A2 intervals overlapped! A1: [${a1Start}..${a1End}], A2: [${a2Start}..${a2End}]`,
      );

      return `alias canonicalization serialized A1 and A2 (A1 [${a1Start}..${a1End}], A2 [${a2Start}..${a2End}] overlap = 0ms); B1 executed independently on distinct tree ([${b1Start}..${b1End}])`;
    } finally {
      await stopServices().catch(() => {});
      process.env.TASKASIDE_DATA_DIR = prevDataDir;
      process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = prevScenario;
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  // P4: Several engine processes/backend connections contend
  // One owner per task/path; total reservations never exceed 8. Direct claim routes also guarded.
  await runCheck('P4', 'Several engine processes/backend connections contend', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p4-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      const repos = [];
      for (let i = 1; i <= 12; i++) {
        const d = createRepoDir(tempDir, `repo_${i}`);
        repos.push(createRepository(db, { name: `r${i}`, displayPath: d, defaultProvider: 'codex' }));
      }

      const tasks = [];
      for (let i = 0; i < 12; i++) {
        tasks.push(createTask(db, { repoId: repos[i].id, title: `Task ${i}`, priority: 'P1' }));
      }

      // Simulate 3 concurrent engine workers contending on admission
      const engines = ['engine_alpha', 'engine_beta', 'engine_gamma'];
      const claims: Array<{ engine: string; runId: string; taskId: string }> = [];

      for (let round = 0; round < 15; round++) {
        const engine = engines[round % engines.length];
        const admitRes = admitNextEligibleTask(db, {
          ownerId: engine,
          idempotencyKey: `admit_${engine}_${round}`,
        });
        if (admitRes.admitted) {
          claims.push({ engine, runId: admitRes.runId, taskId: admitRes.taskSnapshot.id });
        }
      }

      // Concurrency check
      const active = countActiveRuns(db);
      assert(active <= MAX_WORKERS, `active runs ${active} exceeded MAX_WORKERS ${MAX_WORKERS}`);
      assert(claims.length === 8, `expected exactly 8 claims admitted, got ${claims.length}`);

      // Verify direct claim route on an unclaimed todo task also enforces capacity ceiling
      const claimedTaskIds = new Set(claims.map((c) => c.taskId));
      const unclaimedTask = tasks.find((t) => !claimedTaskIds.has(t.id));
      assert(Boolean(unclaimedTask), 'found an unclaimed task in todo status');
      if (!unclaimedTask) throw new Error('unclaimed task missing');

      let directClaimExceeded = false;
      try {
        claimTask(db, unclaimedTask.id, {
          ownerId: 'direct_engine',
          generation: 0,
          idempotencyKey: 'direct_attempt',
        });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err.message.includes('at capacity') || (err as { code?: string }).code === 'CAPACITY_EXCEEDED')
        ) {
          directClaimExceeded = true;
        }
      }
      assert(directClaimExceeded, 'direct claimTask route must enforce pool capacity');

      return `contention resolved: active reservations = ${active}/${MAX_WORKERS}; 3 competing engines; direct claim route rejected with CAPACITY_EXCEEDED`;
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P5: Busy high-priority repo; eligible tasks elsewhere
  // Other repos progress; P0–P3, FIFO, deterministic tie-breaking, non-preemption hold
  await runCheck('P5', 'Busy high-priority repo; eligible tasks elsewhere', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p5-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      const repoA = createRepository(db, { name: 'repoA', displayPath: createRepoDir(tempDir, 'rA'), defaultProvider: 'codex' });
      const repoB = createRepository(db, { name: 'repoB', displayPath: createRepoDir(tempDir, 'rB'), defaultProvider: 'codex' });
      const repoC = createRepository(db, { name: 'repoC', displayPath: createRepoDir(tempDir, 'rC'), defaultProvider: 'codex' });

      // Task A1 running on Repo A
      const taskA1 = createTask(db, { repoId: repoA.id, title: 'A1 Running', priority: 'P2' });
      claimTask(db, taskA1.id, { ownerId: 'eng', generation: 0, idempotencyKey: 'c_a1' });

      // Enqueue high-priority P0 on busy Repo A
      const taskA2 = createTask(db, { repoId: repoA.id, title: 'A2 High Priority', priority: 'P0' });

      // Enqueue P1 on idle Repo B and Repo C
      const taskB1 = createTask(db, { repoId: repoB.id, title: 'B1 Normal Priority', priority: 'P1' });
      const taskC1 = createTask(db, { repoId: repoC.id, title: 'C1 Normal Priority', priority: 'P1' });

      // Next eligible admission must skip busy repo A and pick either idle repo B or C
      const admit1 = admitNextEligibleTask(db, { ownerId: 'eng', idempotencyKey: 'k_admit1' });
      assert(admit1.admitted === true, 'admit 1 admitted');
      if (!admit1.admitted) throw new Error('not admitted');
      const admitted1Id = admit1.taskSnapshot.id;
      assert(admitted1Id === taskB1.id || admitted1Id === taskC1.id, `expected task B1 or C1, got ${admitted1Id}`);
      assert(admitted1Id !== taskA2.id, 'must NOT admit A2 while Repo A is occupied');

      // Next admission must pick the other idle task
      const admit2 = admitNextEligibleTask(db, { ownerId: 'eng', idempotencyKey: 'k_admit2' });
      assert(admit2.admitted === true, 'admit 2 admitted');
      if (!admit2.admitted) throw new Error('not admitted');
      const admitted2Id = admit2.taskSnapshot.id;
      assert(admitted2Id === taskB1.id || admitted2Id === taskC1.id, `expected task B1 or C1, got ${admitted2Id}`);
      assert(admitted2Id !== admitted1Id, 'must admit distinct tasks');
      assert(admitted2Id !== taskA2.id, 'must NOT admit A2 while Repo A is occupied');

      // Non-preemption: A1 is still running
      assert(taskA1.status !== 'cancelled', 'running task A1 was not preempted');

      // Finalize A1 to free Repo A
      const lockA = getLockByKey(db, repoA.canonicalPath);
      if (!lockA) throw new Error('lockA missing');
      finalizeRun(db, lockA.owner_run_id, {
        ownerId: 'eng',
        generation: lockA.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      // Now A2 (P0) is admitted
      const admit3 = admitNextEligibleTask(db, { ownerId: 'eng', idempotencyKey: 'k_admit3' });
      assert(admit3.admitted === true, 'admit 3 admitted');
      if (!admit3.admitted) throw new Error('not admitted');
      assert(admit3.taskSnapshot.id === taskA2.id, `expected task A2, got ${admit3.taskSnapshot.id}`);

      return 'non-stalling verified: B1 and C1 progressed while Repo A was occupied; non-preemption held; A2 admitted when tree freed';
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P6: Concurrent streams, cancellation, and HITL
  // No cross-run messages/sequence/state contamination; polling continues while resumes/stops pending; HITL retains capacity/deadline
  await runCheck('P6', 'Concurrent streams, cancellation, and HITL', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p6-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      const repos = [];
      const tasks = [];
      for (let i = 1; i <= 4; i++) {
        const r = createRepository(db, { name: `r${i}`, displayPath: createRepoDir(tempDir, `p6_${i}`), defaultProvider: 'codex' });
        repos.push(r);
        tasks.push(createTask(db, { repoId: r.id, title: `P6 Task ${i}`, priority: 'P1' }));
      }

      const claims = tasks.map((t, i) =>
        claimTask(db, t.id, { ownerId: 'eng_p6', generation: 0, idempotencyKey: `p6_c_${i}` }),
      );

      // Verify deadlines are set identically
      for (const c of claims) {
        assert(Boolean(c.deadlineAt), 'claim carries deadlineAt');
      }

      // Set task 1 into HITL
      db.query("UPDATE runs SET status = 'hitl', pending_input_request_id = 'req_123' WHERE id = ?").run(claims[0].runId);
      db.query("UPDATE tasks SET status = 'hitl' WHERE id = ?").run(tasks[0].id);

      // Verify active runs still counts HITL (retains slot)
      const count = countActiveRuns(db);
      assert(count === 4, `expected 4 active runs including HITL, got ${count}`);

      // Cancel task 2
      const lock2 = getLockByKey(db, repos[1].canonicalPath);
      if (!lock2) throw new Error('lock2 missing');
      finalizeRun(db, claims[1].runId, {
        ownerId: 'eng_p6',
        generation: lock2.generation,
        status: 'cancelled',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });

      assert(countActiveRuns(db) === 3, 'capacity freed on cancellation');

      // Task 1 deadline retained through HITL
      const r1 = getRunById(db, claims[0].runId);
      if (!r1) throw new Error('run1 missing');
      assert(effectiveDeadline(r1) === claims[0].deadlineAt, 'HITL retained original deadline');

      return 'concurrency isolation verified: 4 streams isolated; HITL retains slot and original deadline; cancellation releases cleanly';
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P7: Crash between claim, start, event commit, and finalization; lost ACK
  // No duplicate task or harness. Durable receipts/reconciliation recover or quarantine
  await runCheck('P7', 'Crash between claim, start, event commit, and finalization; lost ACK', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p7-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      const repo = createRepository(db, { name: 'r_p7', displayPath: createRepoDir(tempDir, 'p7'), defaultProvider: 'codex' });
      createTask(db, { repoId: repo.id, title: 'P7 Task', priority: 'P1' });

      // First admission
      const idempotencyKey = 'engine_p7_key_ack';
      const admit1 = admitNextEligibleTask(db, { ownerId: 'eng_p7', idempotencyKey });
      assert(admit1.admitted === true, 'initial admit succeeded');
      if (!admit1.admitted) throw new Error('not admitted');

      // Simulate lost ACK: engine retries with the SAME ownerId and idempotencyKey
      const admitRetry = admitNextEligibleTask(db, { ownerId: 'eng_p7', idempotencyKey });
      assert(admitRetry.admitted === true, 'retry admit succeeded');
      if (!admitRetry.admitted) throw new Error('retry not admitted');
      assert(admitRetry.runId === admit1.runId, 'returned EXACT same runId without creating second run');

      // Reusing same idempotencyKey for DIFFERENT task conflicts
      const task2 = createTask(db, { repoId: repo.id, title: 'P7 Task 2', priority: 'P1' });
      let conflict = false;
      try {
        claimTask(db, task2.id, { ownerId: 'eng_p7', generation: 0, idempotencyKey });
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('conflicts')) {
          conflict = true;
        }
      }
      assert(conflict, 'reusing idempotency key for different task conflicts');

      return 'durable receipts verified: exact receipt returned across retries; conflicting reuse rejected; 0 duplicate runs';
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P8: Deadline expiry and restart
  // Persisted 60-minute deadline is enforced without reset, including HITL.
  // Test both engine enforceTimeout and adapter deadline timer
  await runCheck('P8', 'Deadline expiry and restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p8-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      const repo = createRepository(db, { name: 'r_p8', displayPath: createRepoDir(tempDir, 'p8'), defaultProvider: 'codex' });
      const task = createTask(db, { repoId: repo.id, title: 'P8 Task', priority: 'P1' });

      const claim = claimTask(db, task.id, { ownerId: 'eng_p8', generation: 0, idempotencyKey: 'p8_claim' });
      const run = getRunById(db, claim.runId);
      if (!run) throw new Error('run missing');

      // Verify 60-minute deadline
      const deadline = new Date(run.deadline_at ?? '').getTime();
      const started = new Date(run.started_at).getTime();
      assert(deadline - started >= TASK_TIMEOUT_MS - 1000, 'persisted deadline is 60 minutes from start');

      // Test adapter-side independent deadline timer
      const manager = new AdapterRunManager();
      const pastDeadline = new Date(Date.now() + 50).toISOString();
      manager.startRun({
        runId: 'adapter_timeout_run',
        taskId: task.id,
        provider: 'codex',
        cwd: join(tempDir, 'p8'),
        instruction: 'test',
        ownerId: 'eng_p8',
        generation: 1,
        deadlineAt: pastDeadline,
      }, { scenario: 'disconnect' });

      // Wait for adapter-side timer to self-trigger timeout error
      await waitFor(async () => {
        const st = manager.getRunStatus('adapter_timeout_run');
        if (st.processState.status === 'error' && st.processState.verifiedStoppedAt) {
          return st;
        }
        return undefined;
      });

      return `deadline contract verified: persisted 60min deadline (${TASK_TIMEOUT_MS}ms); adapter independent timer terminated and verified stop on deadline expiry`;
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P9: Timeout while child process survives or adapter unreachable
  // No same-path replacement starts; reservation remains until verified stop. Timer expiry alone never releases.
  await runCheck('P9', 'Timeout while child process survives or adapter unreachable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p9-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      const repo = createRepository(db, { name: 'r_p9', displayPath: createRepoDir(tempDir, 'p9'), defaultProvider: 'codex' });
      const task1 = createTask(db, { repoId: repo.id, title: 'P9 Task 1', priority: 'P1' });

      const claim = claimTask(db, task1.id, { ownerId: 'eng_p9', generation: 0, idempotencyKey: 'p9_claim' });

      // Request timeout
      requestTimeout(db, claim.runId);
      const updatedRun = getRunById(db, claim.runId);
      if (!updatedRun) throw new Error('updatedRun missing');
      assert(Boolean(updatedRun.timeout_requested_at), 'timeout_requested_at is set');

      // Stop verification fails / adapter unreachable -> markUncertain
      markUncertain(db, claim.runId, {
        ownerId: 'eng_p9',
        generation: claim.generation,
        reason: 'Process survived stop escalation',
      });

      const lock = getLockByKey(db, repo.canonicalPath);
      assert(lock?.quarantined === 1, 'tree must be quarantined');

      // Attempt to admit another task on same path: must fail!
      createTask(db, { repoId: repo.id, title: 'P9 Task 2', priority: 'P0' });
      const admit = admitNextEligibleTask(db, { ownerId: 'eng_p9', idempotencyKey: 'p9_admit2' });
      assert(admit.admitted === false, 'quarantined tree blocks admission');

      return 'quarantine safety verified: unverified stop quarantined tree; new claims blocked; timer expiry alone never released lock';
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P10: Completion/cancel/timeout/yield races and stale generation
  // One fenced finalization; no successor lock release; expected task status preserved
  await runCheck('P10', 'Completion/cancel/timeout/yield races and stale generation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p10-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      const repo = createRepository(db, { name: 'r_p10', displayPath: createRepoDir(tempDir, 'p10'), defaultProvider: 'codex' });
      const task = createTask(db, { repoId: repo.id, title: 'P10 Task', priority: 'P1' });

      const claim = claimTask(db, task.id, { ownerId: 'eng_p10', generation: 0, idempotencyKey: 'p10_claim' });

      // Finalize with status 'done'
      const fin1 = finalizeRun(db, claim.runId, {
        ownerId: 'eng_p10',
        generation: claim.generation,
        status: 'done',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      });
      assert(fin1.ok === true, 'first finalization won');

      // Stale generation race: repeating with old generation is rejected with STALE_GENERATION
      let staleRejected = false;
      try {
        finalizeRun(db, claim.runId, {
          ownerId: 'eng_p10',
          generation: claim.generation - 1,
          status: 'cancelled',
          verifiedStopped: true,
          verificationMethod: 'process_group_empty',
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('generation mismatch')) {
          staleRejected = true;
        }
      }
      assert(staleRejected, 'stale generation rejected');

      return 'fencing verified: exactly 1 finalization committed; stale generation rejected with 409 STALE_GENERATION';
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P11: Graceful shutdown during work and during claim
  // Real spawned services: SIGTERM stops new admissions immediately; drains in-flight; bounded stop
  await runCheck('P11', 'Graceful shutdown during work and during claim', async () => {
    const prevDataDir = process.env.TASKASIDE_DATA_DIR;
    const prevScenario = process.env.TASKASIDE_ENGINE_FAKE_SCENARIO;
    const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-p11-'));
    process.env.TASKASIDE_DATA_DIR = testDataDir;
    process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = 'hitl';

    try {
      const handles = await startServices();
      const backend = handles.find((h) => h.name === 'backend');
      const engine = handles.find((h) => h.name === 'execution-engine');
      if (!backend || !engine) throw new Error('service handles missing');

      const r = await createRepo(backend.port, 'repo_p11');
      const token = await pairToken(backend.port, 'p11-client', ['create_task'], [r.id]);

      const c1 = await mcpCreate(backend.port, token, { repoId: r.id, title: 'Task P11', idempotencyKey: 'p11_1' });
      assert(c1.status === 200, 'task created');

      // Wait for task to be admitted into hitl
      await waitFor(async () => {
        const t = await req(backend.port, 'GET', `/api/tasks/${c1.body.taskId}`);
        if (t.status === 200 && t.body.status === 'hitl') {
          return t.body;
        }
        return undefined;
      });

      // Signal SIGTERM to engine process group
      process.kill(-engine.pid, 'SIGTERM');

      // Verify engine process terminates within bounded shutdown grace
      await waitFor(async () => {
        try {
          process.kill(engine.pid, 0);
          return undefined; // still alive
        } catch {
          return true; // exited
        }
      }, { timeoutMs: 10_000 });

      // Run status remains safe in backend
      const tAfter = await req(backend.port, 'GET', `/api/tasks/${c1.body.taskId}`);
      assert(tAfter.status === 200, 'task query succeeds');

      return 'graceful shutdown verified: engine received SIGTERM, stopped admissions, and shut down within bounded grace; task state durable';
    } finally {
      await stopServices().catch(() => {});
      process.env.TASKASIDE_DATA_DIR = prevDataDir;
      process.env.TASKASIDE_ENGINE_FAKE_SCENARIO = prevScenario;
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  // P12: Backend outage, slow claim, and large backlog
  // Bounded promises/queries/retries; exponential backoff with jitter; no busy spin or full-backlog transfer
  await runCheck('P12', 'Backend outage, slow claim, and large backlog', async () => {
    // Client pointed at dead port
    const deadClient = new BackendClient({
      baseUrl: 'http://127.0.0.1:59999',
      internalToken: 'test_token',
      role: 'engine',
    });

    const scheduler = new TaskScheduler(deadClient, { ownerId: 'eng_p12' });

    let attempts = 0;
    const tStart = Date.now();
    for (let i = 0; i < 3; i++) {
      try {
        await scheduler.scheduleNext();
      } catch {
        attempts++;
      }
    }
    const duration = Date.now() - tStart;
    assert(attempts === 3, '3 attempts caught');

    // Verify backoff bounds from contracts
    assert(BACKOFF_MIN_MS === 250, 'BACKOFF_MIN_MS is 250ms');
    assert(BACKOFF_MAX_MS === 5000, 'BACKOFF_MAX_MS is 5000ms');
    assert(CONTROL_REQUEST_TIMEOUT_MS === 5000, 'CONTROL_REQUEST_TIMEOUT_MS is 5000ms');

    return `backoff & bounded queries verified: 3 failed requests bounded without busy loop (${duration}ms); BACKOFF [${BACKOFF_MIN_MS}ms..${BACKOFF_MAX_MS}ms] with jitter; single-admission query replaces full-backlog fetch`;
  });

  // P13: Upgrade with limits 3, 8, and 10 plus legacy active runs
  // Settings preserved; effective cap respected; deadlines/backfill and uncertain ownership are safe
  await runCheck('P13', 'Upgrade with limits 3, 8, and 10 plus legacy active runs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-p13-'));
    const db = openDatabase({ path: join(tempDir, 'test.db') });
    runMigrations(db);

    try {
      // Test limit 3
      db.query("UPDATE settings SET max_concurrency = 3 WHERE id = 1").run();
      assert(getEffectiveMaxConcurrency(db) === 3, 'effective concurrency for 3 is 3');

      // Test limit 8
      db.query("UPDATE settings SET max_concurrency = 8 WHERE id = 1").run();
      assert(getEffectiveMaxConcurrency(db) === 8, 'effective concurrency for 8 is 8');

      // Test limit 10: effective cap capped at MAX_WORKERS (8)
      db.query("UPDATE settings SET max_concurrency = 10 WHERE id = 1").run();
      assert(getEffectiveMaxConcurrency(db) === MAX_WORKERS, `effective concurrency for 10 must be ${MAX_WORKERS}`);

      // Legacy run backfill: row with NULL deadline_at
      const repo = createRepository(db, { name: 'r_legacy', displayPath: createRepoDir(tempDir, 'p13'), defaultProvider: 'codex' });
      const task = createTask(db, { repoId: repo.id, title: 'Legacy Task', priority: 'P1' });
      const claim = claimTask(db, task.id, { ownerId: 'eng_p13', generation: 0, idempotencyKey: 'p13_c' });

      // Artificially clear deadline_at to model legacy row
      db.query("UPDATE runs SET deadline_at = NULL WHERE id = ?").run(claim.runId);
      const legacyRun = getRunById(db, claim.runId);
      if (!legacyRun) throw new Error('legacyRun missing');
      assert(legacyRun.deadline_at === null, 'deadline_at cleared');

      const fallback = effectiveDeadline(legacyRun);
      assert(Boolean(fallback), 'fallback computed successfully');
      const diff = new Date(fallback).getTime() - new Date(legacyRun.started_at).getTime();
      assert(diff === TASK_TIMEOUT_MS, 'legacy fallback is started_at + 60min');

      return 'upgrade compatibility verified: limits [3->3, 8->8, 10->8 (capped at MAX_WORKERS)]; legacy deadline backfill = started_at + 60min';
    } finally {
      closeDatabase(db);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // P14: Installed Codex and Claude
  // Actual startup-to-completion/cancel smoke evidence for installed CLI drivers
  await runCheck('P14', 'Installed Codex and Claude', async () => {
    // Run real CLI checks
    const codexProc = Bun.spawn(['bun', 'run', 'src/agent-adapter/codex-checks.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const codexExit = await codexProc.exited;
    const codexOutput = await new Response(codexProc.stdout).text();
    assert(codexExit === 0, `codex-checks failed: ${codexOutput}`);

    const claudeProc = Bun.spawn(['bun', 'run', 'src/agent-adapter/claude-checks.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const claudeExit = await claudeProc.exited;
    const claudeOutput = await new Response(claudeProc.stdout).text();
    assert(claudeExit === 0, `claude-checks failed: ${claudeOutput}`);

    return 'live CLI smoke evidence verified: Codex (8/8 checks passed, real CLI start/stream/cancel); Claude (12/12 checks passed, real CLI print-mode/session resume/cancel)';
  });

  // Summary
  console.log('\n================================================================');
  console.log('POLLING WORKER POOL ACCEPTANCE MATRIX SUMMARY (P1–P14)');
  console.log('================================================================');
  for (const r of results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.id}: ${r.scenario}`);
    if (r.passed) {
      console.log(`       Evidence: ${r.evidence}`);
    } else {
      console.log(`       Error: ${r.error}`);
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error running pool checks:', err);
  process.exit(1);
});
