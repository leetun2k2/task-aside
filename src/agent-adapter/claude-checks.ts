// Automated Claude driver verification suite (TASKS.md T18; ARCHITECTURE.md §6; SPECIFICATION.md §2, §3, §6).
// Run: bun run src/agent-adapter/claude-checks.ts
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EventEnvelope,
  EventEnvelopeSchema,
  type StartRunRequest,
} from '../contracts/index.ts';
import {
  ClaudeDriver,
  buildClaudeArgs,
  createAdapterApp,
  mapClaudeJsonLines,
  parseClaudeJsonLine,
  probeAdapterCapabilities,
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
    'echo "# Claude Test Repo" > README.md && git add README.md && git commit -q -m "initial"',
    {
      cwd: dir,
    },
  );
  return dir;
}

async function main(): Promise<void> {
  const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-claude-checks-'));
  process.env.TASKASIDE_DATA_DIR = testDataDir;

  const internalToken = 'test-claude-internal-token-99';
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
        'specs/2026-10-18-initialize-project/evidence/fixtures/claude/events-readonly.jsonl',
      );
      assert(existsSync(fixturePath), `Fixture not found at ${fixturePath}`);
      const rawContent = readFileSync(fixturePath, 'utf8');
      const lines = rawContent.split('\n');

      const mapped = mapClaudeJsonLines(lines, 'run_fixture_ro', 0);
      assert(
        mapped.sessionId === 'REDACTED-SESSION-ID',
        `unexpected sessionId: ${mapped.sessionId}`,
      );
      assert(
        mapped.terminalType === 'completed',
        `unexpected terminalType: ${mapped.terminalType}`,
      );
      assert(mapped.events.length === 2, `expected 2 mapped events, got ${mapped.events.length}`);

      for (const ev of mapped.events) {
        EventEnvelopeSchema.parse(ev);
      }

      assert(
        mapped.events[0].type === 'message.completed',
        'first event must be message.completed',
      );
      assert(mapped.events[0].sequence === 1, 'first sequence must be 1');
      const msgData = mapped.events[0].data as { messageId: string; content: string };
      assert(
        msgData.content.includes('Files in the directory:'),
        'content must include file listing',
      );

      assert(mapped.events[1].type === 'completed', 'second event must be completed');
      assert(mapped.events[1].sequence === 2, 'second sequence must be 2');
      const compData = mapped.events[1].data as { summary: string };
      assert(compData.summary.includes('Files in the directory:'), 'summary must match result');
    });

    // 2. Fixture mapping: events-write.jsonl
    await checkAsync('mapping: parses and maps events-write.jsonl fixture', async () => {
      const fixturePath = join(
        process.cwd(),
        'specs/2026-10-18-initialize-project/evidence/fixtures/claude/events-write.jsonl',
      );
      assert(existsSync(fixturePath), `Fixture not found at ${fixturePath}`);
      const rawContent = readFileSync(fixturePath, 'utf8');
      const lines = rawContent.split('\n');

      const mapped = mapClaudeJsonLines(lines, 'run_fixture_wr', 0);
      assert(
        mapped.sessionId === 'REDACTED-SESSION-ID',
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

      assert(mapped.events[0].type === 'message.completed', 'event 1 must be message.completed');
      assert(
        (mapped.events[0].data as { content: string }).content.includes('trivial file creation'),
        'event 1 content check',
      );

      assert(mapped.events[1].type === 'message.completed', 'event 2 must be message.completed');
      assert(
        (mapped.events[1].data as { content: string }).content.includes('Created hello.txt'),
        'event 2 content check',
      );

      assert(mapped.events[2].type === 'completed', 'event 3 must be completed');
      assert(
        (mapped.events[2].data as { summary: string }).summary.includes('Created hello.txt'),
        'event 3 summary check',
      );
    });

    // 3. Quirk handling: is_error: true on terminal result event overrides subtype: 'success'
    await checkAsync(
      'mapping: maps result with is_error: true and terminal_reason to failed event (even if subtype is "success")',
      async () => {
        const lines = [
          '{"type":"system","subtype":"init","session_id":"sess-fail-1"}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Trying model..."}]}}',
          '{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"terminal_reason":"api_error","result":"Model nonexistent-model-xyz not found"}',
        ];
        const mapped = mapClaudeJsonLines(lines, 'run_fail', 0);
        assert(mapped.sessionId === 'sess-fail-1', 'sessionId should match');
        assert(mapped.terminalType === 'failed', 'terminalType must be failed');
        assert(mapped.events.length === 2, 'expected 2 events: message.completed and failed');

        for (const ev of mapped.events) {
          EventEnvelopeSchema.parse(ev);
        }

        assert(mapped.events[1].type === 'failed', 'terminal event must be failed');
        const data = mapped.events[1].data as { errorCode: string; message: string };
        assert(data.errorCode === 'API_ERROR_404', `unexpected errorCode: ${data.errorCode}`);
        assert(
          data.message.includes('nonexistent-model-xyz'),
          `unexpected message: ${data.message}`,
        );
      },
    );

    // 4. Content block handling: non-text content blocks do not emit empty message.completed
    await checkAsync(
      'mapping: non-text content blocks (thinking, tool_use) do not emit empty message.completed',
      async () => {
        const lines = [
          '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Hmm..."}]}}',
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Glob","input":{"pattern":"*"}}]}}',
          '{"type":"result","subtype":"success","is_error":false,"result":"Done listing"}',
        ];
        const mapped = mapClaudeJsonLines(lines, 'run_tools_only', 0);
        assert(mapped.events.length === 1, 'expected only 1 event (completed)');
        assert(mapped.events[0].type === 'completed', 'must be completed event');
      },
    );

    // 5. CLI Argument builder & scoped MCP
    await checkAsync(
      'cli: buildClaudeArgs configures print mode, permission flags, --strict-mcp-config, and scoped MCP JSON config',
      async () => {
        const runWithoutMcp = {
          cwd: '/path/to/repo',
          instruction: 'Analyze code',
        } as unknown as import('./types.ts').AdapterRun;
        const built1 = buildClaudeArgs(runWithoutMcp);

        assert(built1.args.includes('-p'), 'must include -p');
        assert(built1.args.includes('--permission-mode'), 'must include --permission-mode');
        assert(built1.args.includes('acceptEdits'), 'must include acceptEdits');
        assert(built1.args.includes('--permission-prompts'), 'must include --permission-prompts');
        assert(built1.args.includes('none'), 'must include none');
        assert(built1.args.includes('--output-format'), 'must include --output-format');
        assert(built1.args.includes('stream-json'), 'must include stream-json');
        assert(built1.args.includes('--verbose'), 'must include --verbose');
        assert(built1.args.includes('--strict-mcp-config'), 'must include --strict-mcp-config');
        assert(built1.args.includes('--mcp-config'), 'must include --mcp-config');
        assert(built1.args.includes('{"mcpServers":{}}'), 'mcp-config must be empty json object');
        assert(built1.args.includes('--session-id'), 'must include --session-id for new session');
        assert(Boolean(built1.assignedSessionId), 'must return assignedSessionId');
        assert(
          built1.args[built1.args.length - 1] === 'Analyze code',
          'instruction must be trailing argument',
        );

        const runWithMcp = {
          cwd: '/path/to/repo',
          instruction: 'Run tools',
          mcp: {
            endpoint: 'http://127.0.0.1:40101/mcp',
            accessToken: 'mcp-secret-token-123',
          },
        } as unknown as import('./types.ts').AdapterRun;
        const built2 = buildClaudeArgs(runWithMcp);

        assert(built2.args.includes('--strict-mcp-config'), 'must include --strict-mcp-config');
        const mcpConfigIdx = built2.args.indexOf('--mcp-config');
        assert(mcpConfigIdx !== -1, 'must have --mcp-config');
        const parsedMcp = JSON.parse(built2.args[mcpConfigIdx + 1]);
        assert(
          parsedMcp.mcpServers?.taskaside?.url === 'http://127.0.0.1:40101/mcp',
          'mcp url mismatch',
        );
        assert(
          parsedMcp.mcpServers?.taskaside?.headers?.Authorization === 'Bearer mcp-secret-token-123',
          'mcp header mismatch',
        );
      },
    );

    // 6. CLI Argument builder: session resume vs fresh session
    await checkAsync(
      'cli: buildClaudeArgs supports --resume for existing sessionId and --session-id for new session',
      async () => {
        const runFresh = {
          cwd: '/path/to/repo',
          instruction: 'Fresh turn',
        } as unknown as import('./types.ts').AdapterRun;
        const builtFresh = buildClaudeArgs(runFresh);
        assert(builtFresh.args.includes('--session-id'), 'fresh run must include --session-id');
        assert(!builtFresh.args.includes('--resume'), 'fresh run must NOT include --resume');

        const runResume = {
          cwd: '/path/to/repo',
          instruction: 'Follow-up turn',
          sessionId: 'existing-sess-uuid-456',
        } as unknown as import('./types.ts').AdapterRun;
        const builtResume = buildClaudeArgs(runResume);
        assert(builtResume.args.includes('--resume'), 'resumed run must include --resume');
        assert(
          builtResume.args.includes('existing-sess-uuid-456'),
          'resumed run must pass sessionId',
        );
        assert(
          !builtResume.args.includes('--session-id'),
          'resumed run must NOT include --session-id',
        );
      },
    );

    // 7. Process group termination & verified stop proof
    await checkAsync(
      'lifecycle: terminates process group and returns verified stop proof',
      async () => {
        // Create a temporary mock runner script that sleeps to simulate a running process
        const scriptDir = mkdtempSync(join(tmpdir(), 'taskaside-claude-mock-'));
        const scriptPath = join(scriptDir, 'mock-claude.sh');
        writeFileSync(scriptPath, '#!/bin/sh\n# Mock claude process that sleeps\nsleep 30\n', {
          mode: 0o755,
        });
        chmodSync(scriptPath, 0o755);

        try {
          const mockDriver = new ClaudeDriver({ claudePath: scriptPath });
          const repoDir = createDisposableGitRepo('taskaside-mock-claude-repo-');
          try {
            const run = {
              runId: 'run-mock-claude-cancel',
              taskId: 'task-mock',
              provider: 'claude',
              cwd: repoDir,
              instruction: 'do work',
              ownerId: 'eng-1',
              generation: 1,
              status: 'running',
              lastSequence: 0,
              logPath: join(scriptDir, 'run.log'),
            } as unknown as import('./types.ts').AdapterRun;

            const startPromise = mockDriver.start(run, {
              onEvent: () => {},
              onEnd: () => {},
            });

            // Wait a brief moment for child to spawn
            await Bun.sleep(100);
            assert(run.processGroupPid !== undefined, 'processGroupPid must be set');

            const cancelResult = await mockDriver.cancel(run);
            assert(cancelResult.verifiedStopped === true, 'verifiedStopped must be true');
            assert(
              cancelResult.verificationMethod === 'process_group_empty',
              `unexpected verificationMethod: ${cancelResult.verificationMethod}`,
            );
            assert(run.status === 'cancelled', `run status must be cancelled, got ${run.status}`);

            await startPromise.catch(() => {});
          } finally {
            rmSync(repoDir, { recursive: true, force: true });
          }
        } finally {
          rmSync(scriptDir, { recursive: true, force: true });
        }
      },
    );

    // 8. Unsupported operations: interactive provideInput rejection
    await checkAsync(
      'unsupported: provideInput on Claude run rejects with typed INVALID_TRANSITION',
      async () => {
        const repoDir = createDisposableGitRepo('taskaside-claude-input-reject-');
        try {
          const runId = 'run-claude-input-reject';
          const startRes = await fetch(`${baseUrl}/internal/v1/runs`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify({
              runId,
              taskId: 'task-1',
              provider: 'claude',
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

    // 9. Integration: startRun with claude and sessionId succeeds (resume supported)
    await checkAsync(
      'integration: adapter startRun with claude and sessionId succeeds without VALIDATION_ERROR',
      async () => {
        const repoDir = createDisposableGitRepo('taskaside-claude-resume-');
        try {
          const runId = 'run-claude-resume-accepted';
          const payload: StartRunRequest = {
            runId,
            taskId: 'task-resume',
            provider: 'claude',
            cwd: repoDir,
            instruction: 'Continue previous task',
            ownerId: 'engine-1',
            generation: 1,
            sessionId: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
          };
          const startRes = await fetch(`${baseUrl}/internal/v1/runs`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify(payload),
          });
          // Unlike Codex (which rejects with 400 VALIDATION_ERROR), Claude driver accepts sessionId
          assert(
            startRes.status === 200,
            `expected startRun with sessionId to succeed (200), got ${startRes.status}`,
          );
        } finally {
          rmSync(repoDir, { recursive: true, force: true });
        }
      },
    );

    // 10. Capabilities: adapter reports claude available, resume=true, mcp=true
    await checkAsync(
      'capabilities: adapter reports claude available, resume=true, mcp=true',
      async () => {
        const res = await fetch(`${baseUrl}/capabilities`);
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const caps = (await res.json()) as {
          providers: {
            codex: { available: boolean; resume: boolean; mcp: boolean };
            claude: { available: boolean; resume: boolean; mcp: boolean };
          };
        };
        assert(caps.providers.claude !== undefined, 'claude provider must be reported');
        assert(caps.providers.claude.available === true, 'claude must be available');
        assert(
          caps.providers.claude.resume === true,
          'claude must declare resume: true (verified in T02)',
        );
        assert(
          caps.providers.claude.mcp === true,
          'claude must declare mcp: true (verified in T02)',
        );
      },
    );

    // 11. Live execution: real claude binary streams events and handles failure/quota cleanly
    await checkAsync(
      'live: starts real claude CLI, streams events, and handles terminal failure/quota cleanly',
      async () => {
        const repoDir = createDisposableGitRepo('taskaside-live-claude-');
        try {
          const runId = `run-live-claude-${Date.now()}`;
          const startRes = await fetch(`${baseUrl}/internal/v1/runs`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify({
              runId,
              taskId: 'task-live-claude',
              provider: 'claude',
              cwd: repoDir,
              instruction: 'say hi',
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

          for (const ev of events) {
            EventEnvelopeSchema.parse(ev);
          }

          const terminalEvent = events[events.length - 1];
          // Since quota is exhausted, terminal event is 'failed' (or 'completed' if quota restored)
          assert(
            terminalEvent.type === 'failed' || terminalEvent.type === 'completed',
            `terminal event must be failed or completed, got ${terminalEvent.type}`,
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
            status.processState.status === 'error' || status.processState.status === 'done',
            `expected error or done, got ${status.processState.status}`,
          );
          assert(status.processState.verifiedStoppedAt !== null, 'verifiedStoppedAt must be set');
          assert(
            status.processState.verificationMethod === 'process_group_empty',
            'verificationMethod must be process_group_empty',
          );
        } finally {
          rmSync(repoDir, { recursive: true, force: true });
        }
      },
    );

    // 12. Live cancellation: terminates real claude process group and returns verified stop proof
    await checkAsync(
      'live: cancels real claude CLI, terminates process group, and verifies stop',
      async () => {
        const repoDir = createDisposableGitRepo('taskaside-cancel-claude-');
        try {
          const runId = `run-cancel-claude-${Date.now()}`;
          const startRes = await fetch(`${baseUrl}/internal/v1/runs`, {
            method: 'POST',
            headers: engineHeaders(),
            body: JSON.stringify({
              runId,
              taskId: 'task-cancel-claude',
              provider: 'claude',
              cwd: repoDir,
              instruction:
                'write a 5000 word detailed history of computing with comprehensive essays',
              ownerId: 'engine-1',
              generation: 1,
            }),
          });
          assert(startRes.status === 200, `start failed with ${startRes.status}`);

          const ssePromise = collectSseEvents(
            `${baseUrl}/internal/v1/runs/${runId}/events`,
            engineHeaders(),
          );

          // Brief delay to ensure process group is created
          await Bun.sleep(30);

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
          const terminalEvent = events.find((e) => e.type === 'cancelled' || e.type === 'failed');
          assert(
            terminalEvent !== undefined,
            'SSE stream must receive terminal event (cancelled or failed)',
          );

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
            status.processState.status === 'cancelled' || status.processState.status === 'error',
            `expected terminal status cancelled or error, got ${status.processState.status}`,
          );
          assert(status.processState.verifiedStoppedAt !== null, 'verifiedStoppedAt must be set');
          assert(
            status.processState.verificationMethod === 'process_group_empty',
            'verificationMethod must be process_group_empty',
          );
        } finally {
          rmSync(repoDir, { recursive: true, force: true });
        }
      },
    );
  } finally {
    server.stop(true);
    rmSync(testDataDir, { recursive: true, force: true });
  }

  console.log('\n--- Claude Driver Verification Summary ---');
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
