// Automated Codex driver verification suite (TASKS.md T17; ARCHITECTURE.md §6; SPECIFICATION.md §2, §3, §6).
// Run: bun run src/agent-adapter/codex-checks.ts
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EventEnvelope,
  EventEnvelopeSchema,
  type StartRunRequest,
} from '../contracts/index.ts';
import {
  buildCodexArgs,
  createAdapterApp,
  mapCodexJsonLines,
  parseCodexJsonLine,
} from './index.ts';

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

function createDisposableGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@taskaside.local"', { cwd: dir });
  execSync('git config user.name "TaskAside Test"', { cwd: dir });
  execSync(
    'echo "# Codex Test Repo" > README.md && git add README.md && git commit -q -m "initial"',
    {
      cwd: dir,
    },
  );
  return dir;
}

async function main(): Promise<void> {
  const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-codex-checks-'));
  process.env.TASKASIDE_DATA_DIR = testDataDir;

  const internalToken = 'test-codex-internal-token-99';
  const port = await getFreePort();
  const app = createAdapterApp({ port, internalToken });
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
    idleTimeout: 0,
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const engineHeaders = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${internalToken}`,
    'X-TaskAside-Role': 'engine',
    'Content-Type': 'application/json',
    ...extra,
  });

  try {
    // 1. Fixture mapping: events-readonly.jsonl
    await checkAsync('mapping: parses and maps events-readonly.jsonl fixture', async () => {
      const fixturePath = join(
        process.cwd(),
        'specs/2026-10-18-initialize-project/evidence/fixtures/codex/events-readonly.jsonl',
      );
      assert(existsSync(fixturePath), `Fixture not found at ${fixturePath}`);
      const rawContent = readFileSync(fixturePath, 'utf8');
      const lines = rawContent.split('\n');

      const mapped = mapCodexJsonLines(lines, 'run_fixture_ro', 0);
      assert(
        mapped.sessionId === '01a14e9f-37c0-7c10-9bf2-c322b571db93',
        `unexpected sessionId: ${mapped.sessionId}`,
      );
      assert(
        mapped.terminalType === 'completed',
        `unexpected terminalType: ${mapped.terminalType}`,
      );
      assert(mapped.events.length === 3, `expected 3 mapped events, got ${mapped.events.length}`);

      // Verify each event conforms to flat EventEnvelopeSchema
      for (const ev of mapped.events) {
        EventEnvelopeSchema.parse(ev);
      }

      assert(
        mapped.events[0].type === 'message.completed',
        'first event must be message.completed',
      );
      assert(mapped.events[0].sequence === 1, 'first sequence must be 1');
      assert(
        mapped.events[1].type === 'message.completed',
        'second event must be message.completed',
      );
      assert(mapped.events[1].sequence === 2, 'second sequence must be 2');
      assert(mapped.events[2].type === 'completed', 'third event must be completed');
      assert(mapped.events[2].sequence === 3, 'third sequence must be 3');
    });

    // 2. Fixture mapping: events-write.jsonl
    await checkAsync('mapping: parses and maps events-write.jsonl fixture', async () => {
      const fixturePath = join(
        process.cwd(),
        'specs/2026-10-18-initialize-project/evidence/fixtures/codex/events-write.jsonl',
      );
      assert(existsSync(fixturePath), `Fixture not found at ${fixturePath}`);
      const rawContent = readFileSync(fixturePath, 'utf8');
      const lines = rawContent.split('\n');

      const mapped = mapCodexJsonLines(lines, 'run_fixture_wr', 0);
      assert(
        mapped.sessionId === '01a14f60-fc6a-7903-a7d3-b05bdefc1378' ||
          mapped.sessionId === '01a14e9f-a926-7ea2-9055-043df872f741',
        `unexpected sessionId: ${mapped.sessionId}`,
      );
      assert(
        mapped.terminalType === 'completed',
        `unexpected terminalType: ${mapped.terminalType}`,
      );
      assert(mapped.events.length === 3, `expected 3 mapped events, got ${mapped.events.length}`);

      for (const ev of mapped.events) {
        EventEnvelopeSchema.parse(ev);
      }

      assert(mapped.events[2].type === 'completed', 'final event must be completed');
      assert(
        (mapped.events[2].data as { summary: string }).summary.includes('Hello from Codex'),
        'summary should reflect last message',
      );
    });

    // 3. Mapping: synthetic failure and error streams
    await checkAsync('mapping: maps turn.failed with error payload to failed event', async () => {
      const lines = [
        '{"type":"thread.started","thread_id":"sid-fail-1"}',
        '{"type":"turn.started"}',
        '{"type":"turn.failed","error":{"code":"invalid_request_error","message":"Model not found"}}',
      ];
      const mapped = mapCodexJsonLines(lines, 'run_fail', 0);
      assert(mapped.sessionId === 'sid-fail-1', 'sessionId should match');
      assert(mapped.terminalType === 'failed', 'terminalType should be failed');
      assert(mapped.events.length === 1, 'expected 1 failed event');
      assert(mapped.events[0].type === 'failed', 'event type must be failed');
      const data = mapped.events[0].data as { errorCode: string; message: string };
      assert(data.errorCode === 'invalid_request_error', `unexpected errorCode: ${data.errorCode}`);
      assert(data.message === 'Model not found', `unexpected message: ${data.message}`);
    });

    // 4. CLI Argument builder & scoped MCP
    await checkAsync('cli: buildCodexArgs configures scoped MCP and flags safely', async () => {
      const runWithoutMcp = {
        cwd: '/path/to/repo',
        instruction: 'Write a poem',
      } as unknown as import('./types.ts').AdapterRun;
      const built1 = buildCodexArgs(runWithoutMcp);
      assert(built1.args.includes('exec'), 'must include exec');
      assert(built1.args.includes('--cd'), 'must include --cd');
      assert(built1.args.includes('/path/to/repo'), 'must include cwd');
      assert(built1.args.includes('--approve-for-me'), 'must include --approve-for-me');
      assert(built1.args.includes('--ephemeral'), 'must include --ephemeral');
      assert(built1.args.includes('--json'), 'must include --json');
      assert(built1.args.includes('--ignore-user-config'), 'must include --ignore-user-config');
      assert(
        !built1.args.includes('--sandbox'),
        'must NOT include --sandbox (avoiding clap conflict)',
      );
      assert(Object.keys(built1.env).length === 0, 'env should be empty when no mcp');

      const runWithMcp = {
        cwd: '/path/to/repo',
        instruction: 'Fix bug with tool',
        mcp: {
          endpoint: 'http://127.0.0.1:4000/mcp',
          accessToken: 'secret-mcp-tok-99',
        },
      } as unknown as import('./types.ts').AdapterRun;
      const built2 = buildCodexArgs(runWithMcp);
      assert(
        built2.args.includes('mcp_servers.taskaside.url="http://127.0.0.1:4000/mcp"'),
        'args must configure mcp url',
      );
      assert(
        built2.args.includes('mcp_servers.taskaside.bearer_token_env_var="TASKASIDE_MCP_TOKEN"'),
        'args must configure bearer token env var',
      );
      assert(
        built2.env.TASKASIDE_MCP_TOKEN === 'secret-mcp-tok-99',
        'env must contain TASKASIDE_MCP_TOKEN',
      );
    });

    // 5. Unsupported operations: session resume rejection
    await checkAsync(
      'unsupported: startRun with sessionId rejects with typed VALIDATION_ERROR',
      async () => {
        const repoDir = createDisposableGitRepo('taskaside-resume-reject-');
        try {
          const payload: StartRunRequest = {
            runId: 'run-resume-reject',
            taskId: 'task-1',
            provider: 'codex',
            cwd: repoDir,
            instruction: 'Resume previous work',
            ownerId: 'engine-1',
            generation: 1,
            sessionId: 'prev-thread-123',
          };
          const res = await fetch(`${baseUrl}/internal/v1/runs`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify(payload),
          });
          assert(res.status === 400, `expected 400, got ${res.status}`);
          const body = (await res.json()) as { code: string; message: string };
          assert(body.code === 'VALIDATION_ERROR', `expected VALIDATION_ERROR, got ${body.code}`);
          assert(
            body.message.includes('resume'),
            `expected resume rejection message, got: ${body.message}`,
          );
        } finally {
          rmSync(repoDir, { recursive: true, force: true });
        }
      },
    );

    // 6. Unsupported operations: interactive input rejection
    await checkAsync(
      'unsupported: provideInput on Codex run rejects with typed INVALID_TRANSITION',
      async () => {
        const repoDir = createDisposableGitRepo('taskaside-input-reject-');
        try {
          const runId = 'run-input-reject';
          const startRes = await fetch(`${baseUrl}/internal/v1/runs`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify({
              runId,
              taskId: 'task-1',
              provider: 'codex',
              cwd: repoDir,
              instruction: 'say hi',
              ownerId: 'engine-1',
              generation: 1,
            }),
          });
          assert(startRes.status === 200, `start failed with ${startRes.status}`);

          const inputRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/input`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify({
              ownerId: 'engine-1',
              generation: 1,
              response: 'Here is input',
            }),
          });
          assert(inputRes.status === 400, `expected 400, got ${inputRes.status}`);
          const body = (await inputRes.json()) as { code: string; message: string };
          assert(
            body.code === 'INVALID_TRANSITION' || body.code === 'REQUEST_ALREADY_RESOLVED',
            `expected INVALID_TRANSITION or REQUEST_ALREADY_RESOLVED, got ${body.code}`,
          );
        } finally {
          rmSync(repoDir, { recursive: true, force: true });
        }
      },
    );

    // 7. Live execution: read-only command via real codex binary
    await checkAsync('live: starts codex exec, streams events, and completes cleanly', async () => {
      const repoDir = createDisposableGitRepo('taskaside-live-codex-');
      try {
        const runId = `run-live-codex-${Date.now()}`;
        const startRes = await fetch(`${baseUrl}/internal/v1/runs`, {
          method: 'POST',
          headers: engineHeaders(),
          body: JSON.stringify({
            runId,
            taskId: 'task-live',
            provider: 'codex',
            cwd: repoDir,
            instruction: 'echo hello world',
            ownerId: 'engine-1',
            generation: 1,
          }),
        });
        assert(startRes.status === 200, `start failed with ${startRes.status}`);

        const events = await collectSseEvents(
          `${baseUrl}/internal/v1/runs/${runId}/events`,
          engineHeaders(),
        );
        assert(events.length >= 1, `expected at least 1 event, got ${events.length}`);
        const terminalEvent = events[events.length - 1];
        assert(
          terminalEvent.type === 'completed',
          `final event must be completed, got ${terminalEvent.type}`,
        );

        // Inspect status
        const statusRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}`, {
          headers: engineHeaders(),
        });
        const status = (await statusRes.json()) as {
          runId: string;
          processState: {
            status: string;
            verifiedStoppedAt: string | null;
            verificationMethod: string | null;
            exitCode: number | null;
          };
        };
        assert(
          status.processState.status === 'done',
          `expected done, got ${status.processState.status}`,
        );
        assert(status.processState.verifiedStoppedAt !== null, 'verifiedStoppedAt must be set');
        assert(
          status.processState.verificationMethod === 'process_group_empty',
          'verificationMethod must be process_group_empty',
        );
        assert(
          status.processState.exitCode === 0,
          `exitCode must be 0, got ${status.processState.exitCode}`,
        );
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    // 8. Live cancellation: terminates process group and returns verified stop proof
    await checkAsync(
      'live: cancels codex exec, terminates process group, and verifies stop',
      async () => {
        const repoDir = createDisposableGitRepo('taskaside-cancel-codex-');
        try {
          const runId = `run-cancel-codex-${Date.now()}`;
          const startRes = await fetch(`${baseUrl}/internal/v1/runs`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify({
              runId,
              taskId: 'task-cancel',
              provider: 'codex',
              cwd: repoDir,
              instruction:
                'write a 5000 word detailed history of computing with comprehensive essays',
              ownerId: 'engine-1',
              generation: 1,
            }),
          });
          assert(startRes.status === 200, `start failed with ${startRes.status}`);

          // Wait a brief moment for child process to spawn
          await Bun.sleep(150);

          const ssePromise = collectSseEvents(
            `${baseUrl}/internal/v1/runs/${runId}/events`,
            engineHeaders(),
          );

          const cancelRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}/cancel`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify({
              ownerId: 'engine-1',
              generation: 1,
            }),
          });
          assert(cancelRes.status === 200, `cancel failed with ${cancelRes.status}`);
          const cancelBody = (await cancelRes.json()) as {
            runId: string;
            verifiedStopped: boolean;
            verificationMethod: string;
          };
          assert(cancelBody.verifiedStopped === true, 'verifiedStopped must be true');
          assert(
            cancelBody.verificationMethod === 'process_group_empty',
            `unexpected verificationMethod: ${cancelBody.verificationMethod}`,
          );

          const events = await ssePromise;
          const cancelledEvent = events.find((e) => e.type === 'cancelled');
          assert(cancelledEvent !== undefined, 'SSE stream must receive cancelled event');

          // Status verification
          const statusRes = await fetch(`${baseUrl}/internal/v1/runs/${runId}`, {
            headers: engineHeaders(),
          });
          const status = (await statusRes.json()) as {
            runId: string;
            processState: {
              status: string;
              verifiedStoppedAt: string | null;
              verificationMethod: string | null;
            };
          };
          assert(
            status.processState.status === 'cancelled',
            `status should be cancelled, got ${status.processState.status}`,
          );
          assert(status.processState.verifiedStoppedAt !== null, 'verifiedStoppedAt must be set');
        } finally {
          rmSync(repoDir, { recursive: true, force: true });
        }
      },
    );
  } finally {
    server.stop(true);
    rmSync(testDataDir, { recursive: true, force: true });
  }

  console.log('\n--- Codex Driver Verification Summary ---');
  let failures = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`[PASS] ${r.name}`);
    } else {
      console.log(`[FAIL] ${r.name}: ${r.error}`);
      failures += 1;
    }
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed\n`);
  if (failures > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal runner error:', err);
    process.exit(1);
  });
}
