// Automated agent-adapter verification suite (TASKS.md T16, ARCHITECTURE.md §2.3, §6, §7; SPECIFICATION.md §2, §3, §7).
// Run: bun run src/agent-adapter/adapter-checks.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilitiesResponseSchema,
  type EventEnvelope,
  RunStatusResponseSchema,
} from '../contracts/index.ts';
import { createAdapterApp } from './index.ts';

type CheckResult = { name: string; passed: boolean; error?: string };
const results: CheckResult[] = [];

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('failed to obtain port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function collectSseEvents(
  url: string,
  headers: Record<string, string>,
): Promise<EventEnvelope[]> {
  const res = await fetch(url, { headers });
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
      const isPing = chunk.split('\n').some((line) => line.trim() === 'event: ping');
      if (!isPing) {
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          const parsed = JSON.parse(dataLine.slice('data: '.length));
          if (parsed?.type) {
            events.push(parsed as EventEnvelope);
          }
        }
      }
      sepIndex = buffer.indexOf('\n\n');
    }
  }

  return events;
}

async function main(): Promise<void> {
  const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-adapter-checks-'));
  process.env.TASKASIDE_DATA_DIR = testDataDir;

  const internalToken = 'test-internal-token-42';
  const port = await getFreePort();
  const app = createAdapterApp({ port, internalToken });
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const engineHeaders = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${internalToken}`,
    'X-TaskAside-Role': 'engine',
    'Content-Type': 'application/json',
    ...extra,
  });

  try {
    // 1. Architecture check: zero SQLite imports in src/agent-adapter/
    await checkAsync('boundary: zero sqlite imports in src/agent-adapter/', async () => {
      const forbidden = ['bun', 'sqlite'].join(':');
      const managerCode = readFileSync(join(import.meta.dir, 'manager.ts'), 'utf8');
      const serviceCode = readFileSync(join(import.meta.dir, 'service.ts'), 'utf8');
      const capsCode = readFileSync(join(import.meta.dir, 'capabilities.ts'), 'utf8');
      assert(!managerCode.includes(forbidden), 'manager.ts must not import sqlite');
      assert(!serviceCode.includes(forbidden), 'service.ts must not import sqlite');
      assert(!capsCode.includes(forbidden), 'capabilities.ts must not import sqlite');
    });

    // 2. Health endpoint
    await checkAsync('health: reports ok status and service name', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.status === 'ok', 'expected status ok');
      assert(body.service === 'agent-adapter', `expected agent-adapter, got ${body.service}`);
    });

    // 3. Capabilities discovery
    await checkAsync('capabilities: reports declared provider capabilities honestly', async () => {
      const res = await fetch(`${baseUrl}/capabilities`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      const parsed = CapabilitiesResponseSchema.parse(body);

      // Codex flags per SPECIFICATION.md §6
      assert(parsed.providers.codex.available === true, 'codex should be available in environment');
      assert(parsed.providers.codex.resume === false, 'codex resume must be false/unverified');
      assert(parsed.providers.codex.mcp === false, 'codex mcp must be false until app-server');
      assert(Boolean(parsed.providers.codex.version), 'codex version should be present');

      // Claude flags per SPECIFICATION.md §6
      assert(
        parsed.providers.claude.available === true,
        'claude should be available in environment',
      );
      assert(parsed.providers.claude.resume === true, 'claude resume verified true');
      assert(parsed.providers.claude.mcp === true, 'claude mcp verified true');
      assert(Boolean(parsed.providers.claude.version), 'claude version should be present');
    });

    // 4. Idempotent start and repeated start check
    await checkAsync('start: creates run and repeated start does not spawn twice', async () => {
      const runId = 'run_idempotent_1';
      const body = {
        runId,
        taskId: 'task_01',
        provider: 'claude',
        cwd: testDataDir,
        instruction: 'do test',
        ownerId: 'engine_1',
        generation: 1,
        scenario: 'success',
      };

      const res1 = await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify(body),
      });
      assert(res1.status === 200, `expected 200, got ${res1.status}`);
      const data1 = await res1.json();
      assert(data1.runId === runId, 'expected runId in response');
      assert(data1.started === true, 'expected started=true');

      // Repeated start with same runId, ownerId, generation
      const res2 = await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify(body),
      });
      assert(res2.status === 200, `expected 200, got ${res2.status}`);
      const data2 = await res2.json();
      assert(data2.started === true, 'expected started=true');
      assert(data2.existing === true, 'expected existing=true flag indicating no second spawn');
    });

    // 5. Start with stale generation / owner conflict
    await checkAsync('start: rejects conflict with stale generation or owner', async () => {
      const runId = 'run_fencing_conflict';
      await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({
          runId,
          taskId: 'task_02',
          provider: 'codex',
          cwd: testDataDir,
          instruction: 'do test',
          ownerId: 'engine_1',
          generation: 1,
        }),
      });

      // Different generation -> 409
      const resStaleGen = await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({
          runId,
          taskId: 'task_02',
          provider: 'codex',
          cwd: testDataDir,
          instruction: 'do test',
          ownerId: 'engine_1',
          generation: 2,
        }),
      });
      assert(resStaleGen.status === 409, `expected 409, got ${resStaleGen.status}`);
      const errBody = await resStaleGen.json();
      assert(errBody.code === 'STALE_GENERATION', `expected STALE_GENERATION, got ${errBody.code}`);
    });

    // 6. Validation: non-existent cwd rejected
    await checkAsync('start: rejects non-existent working directory cwd', async () => {
      const res = await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({
          runId: 'run_bad_cwd',
          taskId: 'task_03',
          provider: 'claude',
          cwd: '/path/does/not/exist/at/all',
          instruction: 'do test',
          ownerId: 'engine_1',
          generation: 1,
        }),
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = await res.json();
      assert(body.code === 'VALIDATION_ERROR', `expected VALIDATION_ERROR, got ${body.code}`);
    });

    // 7. Event streaming & monotonic sequence
    await checkAsync('events: streams normalized events with monotonic sequence', async () => {
      const runId = 'run_events_stream_1';
      await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({
          runId,
          taskId: 'task_04',
          provider: 'claude',
          cwd: testDataDir,
          instruction: 'do test',
          ownerId: 'engine_1',
          generation: 1,
          scenario: 'success',
        }),
      });

      const events = await collectSseEvents(
        `${baseUrl}/internal/v1/runs/${runId}/events`,
        engineHeaders(),
      );
      assert(events.length === 3, `expected 3 events, got ${events.length}`);
      assert(events[0].sequence === 1, 'first sequence must be 1');
      assert(events[1].sequence === 2, 'second sequence must be 2');
      assert(events[2].sequence === 3, 'third sequence must be 3');
      assert(events[0].type === 'message.delta', 'seq 1 should be message.delta');
      assert(events[1].type === 'message.completed', 'seq 2 should be message.completed');
      assert(events[2].type === 'completed', 'seq 3 should be completed');
    });

    // 8. Bounded replay with ?after=seq
    await checkAsync('events: ?after=seq parameter filters already received events', async () => {
      const runId = 'run_replay_test';
      await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({
          runId,
          taskId: 'task_05',
          provider: 'codex',
          cwd: testDataDir,
          instruction: 'do test',
          ownerId: 'engine_1',
          generation: 1,
          scenario: 'success',
        }),
      });

      // Wait a moment for run to complete
      await new Promise((r) => setTimeout(r, 50));

      const replayed = await collectSseEvents(
        `${baseUrl}/internal/v1/runs/${runId}/events?after=1`,
        engineHeaders(),
      );
      assert(replayed.length === 2, `expected 2 events after seq 1, got ${replayed.length}`);
      assert(replayed[0].sequence === 2, `expected seq 2, got ${replayed[0].sequence}`);
      assert(replayed[1].sequence === 3, `expected seq 3, got ${replayed[1].sequence}`);
    });

    // 9. Safe terminal and process state distinction
    await checkAsync(
      'status: distinguishes running from verified-stopped terminal state',
      async () => {
        const runId = 'run_terminal_distinction';
        await fetch(`${baseUrl}/internal/v1/runs`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            runId,
            taskId: 'task_06',
            provider: 'claude',
            cwd: testDataDir,
            instruction: 'do test',
            ownerId: 'engine_1',
            generation: 1,
            scenario: 'success',
          }),
        });

        // Wait for completion
        await new Promise((r) => setTimeout(r, 60));

        const res = await fetch(`${baseUrl}/internal/v1/runs/${runId}`, {
          headers: engineHeaders(),
        });
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const body = await res.json();
        const parsed = RunStatusResponseSchema.parse(body);

        assert(
          parsed.processState.status === 'done',
          `expected done, got ${parsed.processState.status}`,
        );
        assert(
          parsed.processState.verifiedStoppedAt !== null,
          'verifiedStoppedAt must be populated for terminal run',
        );
        assert(
          parsed.processState.verificationMethod === 'process_group_empty',
          `expected process_group_empty, got ${parsed.processState.verificationMethod}`,
        );
        assert(parsed.processState.exitCode === 0, 'expected exitCode 0');
      },
    );

    // 10. Failure scenario terminal state
    await checkAsync('status: failure scenario reports error status and exit code', async () => {
      const runId = 'run_failure_test';
      await fetch(`${baseUrl}/internal/v1/runs`, {
        method: 'POST',
        headers: engineHeaders(),
        body: JSON.stringify({
          runId,
          taskId: 'task_07',
          provider: 'claude',
          cwd: testDataDir,
          instruction: 'do test',
          ownerId: 'engine_1',
          generation: 1,
          scenario: 'failure',
        }),
      });

      await new Promise((r) => setTimeout(r, 60));

      const res = await fetch(`${baseUrl}/internal/v1/runs/${runId}/status`, {
        headers: engineHeaders(),
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      const parsed = RunStatusResponseSchema.parse(body);

      assert(
        parsed.processState.status === 'error',
        `expected error, got ${parsed.processState.status}`,
      );
      assert(parsed.processState.verifiedStoppedAt !== null, 'verifiedStoppedAt must be set');
      assert(
        parsed.processState.verificationMethod === 'process_group_empty',
        'verification method set',
      );
      assert(
        parsed.processState.exitCode === 1,
        `expected exitCode 1, got ${parsed.processState.exitCode}`,
      );
    });

    // 11. Scoped HITL input handling
    await checkAsync(
      'hitl: input_required transitions to hitl, answer resumes to done',
      async () => {
        const runId = 'run_hitl_test';
        await fetch(`${baseUrl}/internal/v1/runs`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            runId,
            taskId: 'task_08',
            provider: 'claude',
            cwd: testDataDir,
            instruction: 'do test',
            ownerId: 'engine_1',
            generation: 1,
            scenario: 'hitl',
          }),
        });

        await new Promise((r) => setTimeout(r, 30));

        const statusRes1 = await fetch(`${baseUrl}/internal/v1/runs/${runId}`, {
          headers: engineHeaders(),
        });
        const status1 = await statusRes1.json();
        assert(
          status1.processState.status === 'hitl',
          `expected hitl status, got ${status1.processState.status}`,
        );

        // Try reply with stale generation -> 409
        const staleReplyRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/input`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            ownerId: 'engine_1',
            generation: 99,
            requestId: 'req_1',
            response: 'target staging',
          }),
        });
        assert(
          staleReplyRes.status === 409,
          `expected 409 on stale gen, got ${staleReplyRes.status}`,
        );

        // Valid reply
        const replyRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/input`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            ownerId: 'engine_1',
            generation: 1,
            requestId: 'req_1',
            response: 'target staging',
          }),
        });
        assert(replyRes.status === 200, `expected 200, got ${replyRes.status}`);

        // Repeated reply -> 409 REQUEST_ALREADY_RESOLVED
        const duplicateReplyRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/input`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            ownerId: 'engine_1',
            generation: 1,
            requestId: 'req_1',
            response: 'target staging again',
          }),
        });
        assert(
          duplicateReplyRes.status === 409,
          `expected 409 on resolved hitl, got ${duplicateReplyRes.status}`,
        );
        const dupBody = await duplicateReplyRes.json();
        assert(
          dupBody.code === 'REQUEST_ALREADY_RESOLVED',
          `expected REQUEST_ALREADY_RESOLVED, got ${dupBody.code}`,
        );

        // Wait for post-input run to finish
        await new Promise((r) => setTimeout(r, 60));

        const statusRes2 = await fetch(`${baseUrl}/internal/v1/runs/${runId}`, {
          headers: engineHeaders(),
        });
        const status2 = await statusRes2.json();
        assert(
          status2.processState.status === 'done',
          `expected done after resume, got ${status2.processState.status}`,
        );
        assert(
          status2.processState.verifiedStoppedAt !== null,
          'verifiedStoppedAt set after resume',
        );
      },
    );

    // 12. Safe cancellation
    await checkAsync(
      'cancel: stops running process, verifies stop, returns idempotent proof',
      async () => {
        const runId = 'run_cancel_test';
        await fetch(`${baseUrl}/internal/v1/runs`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            runId,
            taskId: 'task_09',
            provider: 'claude',
            cwd: testDataDir,
            instruction: 'do test',
            ownerId: 'engine_1',
            generation: 1,
            scenario: 'disconnect', // leaves run in running state
          }),
        });

        await new Promise((r) => setTimeout(r, 20));

        // Cancel with mismatched owner -> 409
        const staleCancelRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/cancel`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            ownerId: 'wrong_engine',
            generation: 1,
          }),
        });
        assert(staleCancelRes.status === 409, `expected 409, got ${staleCancelRes.status}`);

        // Valid cancel
        const cancelRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/cancel`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            ownerId: 'engine_1',
            generation: 1,
            reason: 'user cancelled',
          }),
        });
        assert(cancelRes.status === 200, `expected 200, got ${cancelRes.status}`);
        const cancelBody = await cancelRes.json();
        assert(cancelBody.verifiedStopped === true, 'verifiedStopped must be true');
        assert(
          cancelBody.verificationMethod === 'process_group_empty',
          'expected process_group_empty',
        );

        // Idempotent cancel
        const repeatCancelRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/cancel`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            ownerId: 'engine_1',
            generation: 1,
          }),
        });
        assert(repeatCancelRes.status === 200, 'repeated cancel should return 200');
        const repeatBody = await repeatCancelRes.json();
        assert(repeatBody.verifiedStopped === true, 'repeat verifiedStopped must be true');

        // Check status
        const statusRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}`, {
          headers: engineHeaders(),
        });
        const status = await statusRes.json();
        assert(
          status.processState.status === 'cancelled',
          `expected cancelled, got ${status.processState.status}`,
        );
        assert(
          status.processState.exitCode === 143,
          `expected 143, got ${status.processState.exitCode}`,
        );
      },
    );

    // 13. Security and Host/Origin hardening
    await checkAsync(
      'security: unauthenticated and cross-origin requests are rejected',
      async () => {
        // Missing auth -> 401
        const noAuth = await fetch(`${baseUrl}/internal/v1/runs/dummy`, {
          headers: { 'X-TaskAside-Role': 'engine' },
        });
        assert(noAuth.status === 401, `expected 401, got ${noAuth.status}`);

        // Missing role -> 403
        const noRole = await fetch(`${baseUrl}/internal/v1/runs/dummy`, {
          headers: { Authorization: `Bearer ${internalToken}` },
        });
        assert(noRole.status === 403, `expected 403, got ${noRole.status}`);

        // Browser role forbidden on adapter internal routes -> 403
        const browserRole = await fetch(`${baseUrl}/internal/v1/runs/dummy`, {
          headers: {
            Authorization: `Bearer ${internalToken}`,
            'X-TaskAside-Role': 'browser',
          },
        });
        assert(
          browserRole.status === 403,
          `expected 403 for browser role, got ${browserRole.status}`,
        );
      },
    );

    // 14. Unknown run returns 404
    await checkAsync('error: non-existent run returns 404 NOT_FOUND', async () => {
      const res = await fetch(`${baseUrl}/internal/v1/runs/non_existent_123`, {
        headers: engineHeaders(),
      });
      assert(res.status === 404, `expected 404, got ${res.status}`);
      const body = await res.json();
      assert(body.code === 'NOT_FOUND', `expected NOT_FOUND, got ${body.code}`);
    });
  } finally {
    server.stop(true);
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // Summary
  console.log('\n--- Agent Adapter Verification Summary ---');
  let failures = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`[PASS] ${r.name}`);
    } else {
      failures++;
      console.log(`[FAIL] ${r.name}: ${r.error}`);
    }
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exit(1);
});
