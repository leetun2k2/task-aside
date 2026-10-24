// Automated deterministic run harness verification suite (T09).
// Run: bun run src/harness/harness-checks.ts
//
// Exercises a fake backend + fake agent adapter + disposable git repos to
// reproduce success/failure lifecycles, duplicate events, lost ACKs, HITL,
// disconnects and uncertain-process quarantine without any model access.
// Also scans source for the SQLite/service-shell boundaries required by the
// M1 gate (AGENTS.md §3, CONSTITUTION.md §II/§III).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EventEnvelope } from '../contracts/index.ts';
import { getFreePort } from '../supervisor/ports.ts';
import { createDisposableRepo } from './disposable-repo.ts';
import { createFakeAdapter, createFakeAdapterState } from './fake-adapter.ts';
import { createFakeBackend, createFakeBackendState } from './fake-backend.ts';

type CheckResult = { name: string; passed: boolean; error?: string };
const results: CheckResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Harness wiring ---------------------------------------------------------

const INTERNAL_TOKEN = 'harness-internal-token';
process.env.TASKASIDE_INTERNAL_TOKEN = INTERNAL_TOKEN;

function engineHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
    'X-TaskAside-Role': 'engine',
    'Content-Type': 'application/json',
  };
}

interface ClaimResponse {
  runId: string;
  generation: number;
  leaseExpiresAt: string;
}

interface ClaimArgs {
  taskId: string;
  repoPath: string;
  ownerId: string;
  idempotencyKey: string;
}

async function claim(
  backendUrl: string,
  args: ClaimArgs,
): Promise<{ status: number; body: ClaimResponse | { code: string; message: string } }> {
  const res = await fetch(`${backendUrl}/internal/v1/runs/claim`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({
      ownerId: args.ownerId,
      generation: 0,
      idempotencyKey: args.idempotencyKey,
      taskId: args.taskId,
      repoPath: args.repoPath,
    }),
  });
  return { status: res.status, body: (await res.json()) as ClaimResponse };
}

async function postEvents(
  backendUrl: string,
  runId: string,
  ownerId: string,
  generation: number,
  events: EventEnvelope[],
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${backendUrl}/internal/v1/runs/${runId}/events`, {
    method: 'POST',
    headers: { ...engineHeaders(), ...extraHeaders },
    body: JSON.stringify({ ownerId, generation, events }),
  });
}

async function finalize(
  backendUrl: string,
  runId: string,
  ownerId: string,
  generation: number,
  status: 'done' | 'error' | 'cancelled',
): Promise<Response> {
  return fetch(`${backendUrl}/internal/v1/runs/${runId}/finalize`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({
      ownerId,
      generation,
      status,
      verifiedStopped: true,
      verificationMethod: 'process_group_empty',
      summary: 'harness run',
    }),
  });
}

interface StartAdapterRunArgs {
  runId: string;
  taskId: string;
  repoPath: string;
  ownerId: string;
  generation: number;
  scenario: string;
}

async function startAdapterRun(adapterUrl: string, args: StartAdapterRunArgs): Promise<Response> {
  return fetch(`${adapterUrl}/internal/v1/runs/start`, {
    method: 'POST',
    headers: engineHeaders(),
    body: JSON.stringify({
      runId: args.runId,
      taskId: args.taskId,
      provider: 'claude',
      cwd: args.repoPath,
      instruction: 'harness instruction',
      ownerId: args.ownerId,
      generation: args.generation,
      scenario: args.scenario,
    }),
  });
}

async function collectSseEvents(url: string): Promise<EventEnvelope[]> {
  const res = await fetch(url, { headers: engineHeaders() });
  if (!res.body) {
    throw new Error('expected an SSE response body');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: EventEnvelope[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let sepIndex = buffer.indexOf('\n\n');
    while (sepIndex !== -1) {
      const chunk = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) {
        events.push(JSON.parse(dataLine.slice('data: '.length)) as EventEnvelope);
      }
      sepIndex = buffer.indexOf('\n\n');
    }
  }

  return events;
}

async function main(): Promise<void> {
  const backendPort = await getFreePort();
  const adapterPort = await getFreePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const adapterUrl = `http://127.0.0.1:${adapterPort}`;

  const backendState = createFakeBackendState();
  const adapterState = createFakeAdapterState();
  const backendServer = Bun.serve({
    port: backendPort,
    hostname: '127.0.0.1',
    fetch: createFakeBackend(backendPort, backendState).fetch,
  });
  const adapterServer = Bun.serve({
    port: adapterPort,
    hostname: '127.0.0.1',
    fetch: createFakeAdapter(adapterPort, adapterState).fetch,
  });

  const repos: Array<{ destroy: () => void }> = [];

  try {
    // --- 1. Clean success lifecycle ----------------------------------------
    await check('success lifecycle: claim -> stream -> ingest -> finalize -> release', async () => {
      const repo = await createDisposableRepo();
      repos.push(repo);

      const claimRes = await claim(backendUrl, {
        taskId: 'task-success',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-1',
        idempotencyKey: 'idem-success',
      });
      assert(claimRes.status === 200, `expected 200 on claim, got ${claimRes.status}`);
      const { runId, generation } = claimRes.body as ClaimResponse;

      const startRes = await startAdapterRun(adapterUrl, {
        runId,
        taskId: 'task-success',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-1',
        generation,
        scenario: 'success',
      });
      assert(startRes.status === 200, `expected 200 on adapter start, got ${startRes.status}`);

      const events = await collectSseEvents(`${adapterUrl}/internal/v1/runs/${runId}/events`);
      assert(events.length === 3, `expected 3 streamed events, got ${events.length}`);

      // Disposable repo mutation: the "agent" writes a file into the working tree.
      writeFileSync(join(repo.repoPath, 'output.txt'), 'created by harness run\n');

      const persistent = events.filter((event) => event.type !== 'message.delta');
      const ingestRes = await postEvents(backendUrl, runId, 'engine-1', generation, persistent);
      assert(ingestRes.status === 200, `expected 200 on event ingest, got ${ingestRes.status}`);

      const finalizeRes = await finalize(backendUrl, runId, 'engine-1', generation, 'done');
      assert(finalizeRes.status === 200, `expected 200 on finalize, got ${finalizeRes.status}`);

      const reclaimRes = await claim(backendUrl, {
        taskId: 'task-success-2',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-1',
        idempotencyKey: 'idem-reclaim',
      });
      assert(reclaimRes.status === 200, 'expected lock to be released after finalize');
    });

    // --- 2. Agent failure lifecycle -----------------------------------------
    await check('failure lifecycle: claim -> stream failure -> finalize error', async () => {
      const repo = await createDisposableRepo();
      repos.push(repo);

      const claimRes = await claim(backendUrl, {
        taskId: 'task-failure',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-1',
        idempotencyKey: 'idem-failure',
      });
      assert(claimRes.status === 200, `expected 200 on claim, got ${claimRes.status}`);
      const { runId, generation } = claimRes.body as ClaimResponse;

      await startAdapterRun(adapterUrl, {
        runId,
        taskId: 'task-failure',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-1',
        generation,
        scenario: 'failure',
      });
      const events = await collectSseEvents(`${adapterUrl}/internal/v1/runs/${runId}/events`);
      assert(events.at(-1)?.type === 'failed', 'expected scenario to end with a failed event');

      const persistent = events.filter((event) => event.type !== 'message.delta');
      const ingestRes = await postEvents(backendUrl, runId, 'engine-1', generation, persistent);
      assert(ingestRes.status === 200, `expected 200 on event ingest, got ${ingestRes.status}`);

      const finalizeRes = await finalize(backendUrl, runId, 'engine-1', generation, 'error');
      assert(finalizeRes.status === 200, `expected 200 on finalize, got ${finalizeRes.status}`);
    });

    // --- 3/4/5. Duplicate events, sequence conflict, lost ACK ----------------
    let dedupRunId = '';
    let dedupGeneration = 0;
    const dedupOwnerId = 'engine-dedup';

    function postDedupEvent(event: EventEnvelope, headers?: Record<string, string>) {
      return postEvents(backendUrl, dedupRunId, dedupOwnerId, dedupGeneration, [event], headers);
    }

    await check('dedup setup: claim a run for event idempotency checks', async () => {
      const dedupRepo = await createDisposableRepo();
      repos.push(dedupRepo);
      const res = await claim(backendUrl, {
        taskId: 'task-dedup',
        repoPath: dedupRepo.canonicalPath,
        ownerId: dedupOwnerId,
        idempotencyKey: 'idem-dedup',
      });
      assert(res.status === 200, `expected 200 on claim, got ${res.status}`);
      const body = res.body as ClaimResponse;
      dedupRunId = body.runId;
      dedupGeneration = body.generation;
    });

    await check('duplicate event: identical retry acknowledged, no double commit', async () => {
      const event: EventEnvelope = {
        runId: dedupRunId,
        sequence: 1,
        type: 'completed',
        timestamp: new Date().toISOString(),
        data: { summary: 'first commit' },
      };

      const first = await postDedupEvent(event);
      assert(first.status === 200, `expected 200 on first ingest, got ${first.status}`);

      const retry = await postDedupEvent(event);
      assert(retry.status === 200, `expected 200 on identical retry, got ${retry.status}`);
    });

    await check('sequence conflict: different payload at same sequence -> 409', async () => {
      const conflicting: EventEnvelope = {
        runId: dedupRunId,
        sequence: 1,
        type: 'completed',
        timestamp: new Date().toISOString(),
        data: { summary: 'a conflicting commit' },
      };
      const res = await postDedupEvent(conflicting);
      assert(res.status === 409, `expected 409, got ${res.status}`);
      const body = (await res.json()) as { code: string };
      assert(body.code === 'SEQUENCE_CONFLICT', `expected SEQUENCE_CONFLICT, got ${body.code}`);
    });

    await check('lost ACK recovery: dropped response, identical retry acknowledged', async () => {
      const lostAckEvent: EventEnvelope = {
        runId: dedupRunId,
        sequence: 2,
        type: 'completed',
        timestamp: new Date().toISOString(),
        data: { summary: 'lost ack commit' },
      };

      const dropped = await postDedupEvent(lostAckEvent, { 'x-simulate-lost-ack': 'true' });
      assert(dropped.status === 503, `expected simulated 503 drop, got ${dropped.status}`);

      const retry = await postDedupEvent(lostAckEvent);
      assert(retry.status === 200, `expected 200 on retried tuple, got ${retry.status}`);

      // Verify single commit: a conflicting payload at the same sequence must
      // still be rejected against the originally stored hash, proving the
      // dropped attempt's commit was not silently skipped or duplicated.
      const conflict = await postDedupEvent({
        ...lostAckEvent,
        data: { summary: 'should conflict' },
      });
      assert(conflict.status === 409, 'expected the committed event to still guard sequence 2');
    });

    // --- 6. HITL input and atomic reply --------------------------------------
    await check('HITL: input_required pauses run; reply resolves; duplicate rejected', async () => {
      const repo = await createDisposableRepo();
      repos.push(repo);

      const claimRes = await claim(backendUrl, {
        taskId: 'task-hitl',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-hitl',
        idempotencyKey: 'idem-hitl',
      });
      assert(claimRes.status === 200, `expected 200 on claim, got ${claimRes.status}`);
      const { runId, generation } = claimRes.body as ClaimResponse;

      await startAdapterRun(adapterUrl, {
        runId,
        taskId: 'task-hitl',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-hitl',
        generation,
        scenario: 'hitl',
      });
      const events = await collectSseEvents(`${adapterUrl}/internal/v1/runs/${runId}/events`);
      assert(events.at(-1)?.type === 'input_required', 'expected a pausing input_required event');

      const ingestRes = await postEvents(backendUrl, runId, 'engine-hitl', generation, events);
      assert(ingestRes.status === 200, `expected 200 on event ingest, got ${ingestRes.status}`);

      const reply = await fetch(`${backendUrl}/internal/v1/tasks/task-hitl/messages`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({ content: 'use staging', inReplyToRequestId: 'req_1' }),
      });
      assert(reply.status === 200, `expected 200 on reply, got ${reply.status}`);

      const duplicateReply = await fetch(`${backendUrl}/internal/v1/tasks/task-hitl/messages`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({ content: 'use staging again', inReplyToRequestId: 'req_1' }),
      });
      const dupStatus = duplicateReply.status;
      assert(dupStatus === 409, `expected 409 on duplicate reply, got ${dupStatus}`);
      const body = (await duplicateReply.json()) as { code: string };
      assert(
        body.code === 'REQUEST_ALREADY_RESOLVED',
        `expected REQUEST_ALREADY_RESOLVED, got ${body.code}`,
      );
    });

    // --- 7. Disconnect and status inspection ---------------------------------
    await check('disconnect: SSE ends mid-run; status check avoids a duplicate spawn', async () => {
      const repo = await createDisposableRepo();
      repos.push(repo);

      const claimRes = await claim(backendUrl, {
        taskId: 'task-disconnect',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-dc',
        idempotencyKey: 'idem-dc',
      });
      assert(claimRes.status === 200, `expected 200 on claim, got ${claimRes.status}`);
      const { runId, generation } = claimRes.body as ClaimResponse;

      const runArgs: StartAdapterRunArgs = {
        runId,
        taskId: 'task-disconnect',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-dc',
        generation,
        scenario: 'disconnect',
      };
      await startAdapterRun(adapterUrl, runArgs);
      const runsBefore = adapterState.runs.size;

      const events = await collectSseEvents(`${adapterUrl}/internal/v1/runs/${runId}/events`);
      assert(events.length === 1, `expected the stream to end after 1 event, got ${events.length}`);

      const statusRes = await fetch(`${adapterUrl}/internal/v1/runs/${runId}/status`, {
        headers: engineHeaders(),
      });
      assert(statusRes.status === 200, `expected 200 on status check, got ${statusRes.status}`);
      const statusBody = (await statusRes.json()) as { processState: { status: string } };
      assert(
        statusBody.processState.status === 'running',
        `expected run still inspectable as running, got ${statusBody.processState.status}`,
      );

      const restartRes = await startAdapterRun(adapterUrl, runArgs);
      const restartStatus = restartRes.status;
      assert(restartStatus === 200, `expected idempotent restart 200, got ${restartStatus}`);
      assert(adapterState.runs.size === runsBefore, 'expected no second run for the same runId');
    });

    // --- 8. Uncertain process state and lock quarantine ----------------------
    await check('quarantine: mark-uncertain blocks claims; clear-quarantine unblocks', async () => {
      const repo = await createDisposableRepo();
      repos.push(repo);

      const claimRes = await claim(backendUrl, {
        taskId: 'task-uncertain',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-unc',
        idempotencyKey: 'idem-unc',
      });
      assert(claimRes.status === 200, `expected 200 on claim, got ${claimRes.status}`);
      const { runId, generation } = claimRes.body as ClaimResponse;

      const markRes = await fetch(`${backendUrl}/internal/v1/runs/${runId}/mark-uncertain`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({ ownerId: 'engine-unc', generation, reason: 'lost heartbeat' }),
      });
      assert(markRes.status === 200, `expected 200 on mark-uncertain, got ${markRes.status}`);

      const blockedClaim = await claim(backendUrl, {
        taskId: 'task-uncertain-2',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-unc2',
        idempotencyKey: 'idem-unc2',
      });
      const blockedStatus = blockedClaim.status;
      assert(blockedStatus === 409, `expected 409 on quarantined lock, got ${blockedStatus}`);
      const blockedBody = blockedClaim.body as { code: string };
      assert(blockedBody.code === 'LOCK_HELD', `expected LOCK_HELD, got ${blockedBody.code}`);

      const clearRes = await fetch(`${backendUrl}/internal/v1/runs/${runId}/clear-quarantine`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({ operatorId: 'operator-1', reason: 'verified termination' }),
      });
      assert(clearRes.status === 200, `expected 200 on clear-quarantine, got ${clearRes.status}`);

      const unblockedClaim = await claim(backendUrl, {
        taskId: 'task-uncertain-3',
        repoPath: repo.canonicalPath,
        ownerId: 'engine-unc3',
        idempotencyKey: 'idem-unc3',
      });
      assert(unblockedClaim.status === 200, 'expected claim to succeed after clear-quarantine');
    });

    // --- 9. Process boundary: no bun:sqlite outside backend ------------------
    await check('boundary: no bun:sqlite imports outside a backend domain', () => {
      const repoRoot = process.cwd();
      const srcRoot = join(repoRoot, 'src');
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
          if (fullPath === import.meta.path) {
            continue;
          }
          const content = readFileSync(fullPath, 'utf8');
          if (content.includes('bun:sqlite')) {
            offenders.push(relative(repoRoot, fullPath));
          }
        }
      };
      walk(srcRoot);

      const backendDir = join('src', 'backend');
      const nonBackendOffenders = offenders.filter((path) => !path.startsWith(backendDir));
      const found = nonBackendOffenders.join(', ');
      assert(
        nonBackendOffenders.length === 0,
        `expected zero bun:sqlite imports outside src/backend, found: ${found}`,
      );
    });

    // --- 10. Service shell sanity check --------------------------------------
    await check('boundary: service shells do not schedule real coding work', () => {
      const repoRoot = process.cwd();
      const shellPaths = [
        join('src', 'cmd', 'backend.ts'),
        join('src', 'cmd', 'agent-adapter.ts'),
        join('src', 'cmd', 'execution-engine.ts'),
        join('src', 'cmd', 'cli.ts'),
      ];
      const forbiddenPatterns = [
        '/runs/claim',
        '/runs/start',
        'claimTask',
        'startRun(',
        'runnable',
        'scheduleNext',
        'spawn(',
      ];

      for (const relPath of shellPaths) {
        const content = readFileSync(join(repoRoot, relPath), 'utf8');
        for (const pattern of forbiddenPatterns) {
          assert(!content.includes(pattern), `${relPath} unexpectedly references '${pattern}'`);
        }
      }
    });
  } finally {
    backendServer.stop(true);
    adapterServer.stop(true);
    for (const repo of repos) {
      repo.destroy();
    }
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
