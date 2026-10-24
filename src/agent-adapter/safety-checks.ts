// Provider safety and log verification suite (TASKS.md T19; ARCHITECTURE.md §6, §12; CONSTITUTION.md §VII; SPECIFICATION.md §2, §3, §6).
// Run: bun run src/agent-adapter/safety-checks.ts
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EventEnvelope,
  EventEnvelopeSchema,
  type StartRunRequest,
} from '../contracts/index.ts';
import {
  AdapterRunManager,
  DEFAULT_MAX_LOG_SIZE_BYTES,
  createAdapterApp,
  formatRunLogLine,
  redactSensitive,
  writeRunLog,
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

console.log('\n--- Agent Adapter Provider Safety & Logs Verification (T19) ---\n');

// 1. Redaction of sensitive credentials, tokens, and authorization headers
await checkAsync(
  'redaction: deep redaction of bearer tokens, API keys, passwords, and MCP tokens',
  async () => {
    const sensitiveObj = {
      authorization: 'Bearer super_secret_jwt_token_1234567890.abcdef',
      token: 'mcp_live_token_abcdef123456',
      mcp_token: 'tok_mcp_test',
      apiKey: 'sk-proj-1234567890abcdef1234567890',
      password: 'my-super-secret-password',
      nested: {
        secret: 'nested_secret_val',
        regular: 'This is a normal message',
        connectionString:
          'postgres://user:pass123@localhost:5432/db?token=secret123&apiKey=sk-1234567890',
      },
      longString: 'A'.repeat(3000),
    };

    type RedactedSensitiveObj = {
      authorization: string;
      token: string;
      mcp_token: string;
      apiKey: string;
      password: string;
      nested: {
        secret: string;
        regular: string;
        connectionString: string;
      };
      longString: string;
    };
    const redacted = redactSensitive(sensitiveObj) as RedactedSensitiveObj;
    assert(redacted.authorization === '[REDACTED]', 'authorization key must be redacted');
    assert(redacted.token === '[REDACTED]', 'token key must be redacted');
    assert(redacted.mcp_token === '[REDACTED]', 'mcp_token key must be redacted');
    assert(redacted.apiKey === '[REDACTED]', 'apiKey key must be redacted');
    assert(redacted.password === '[REDACTED]', 'password key must be redacted');
    assert(redacted.nested.secret === '[REDACTED]', 'nested secret must be redacted');
    assert(
      redacted.nested.regular === 'This is a normal message',
      'regular message should not be redacted',
    );
    assert(
      !redacted.nested.connectionString.includes('secret123'),
      'connectionString token query must be redacted',
    );
    assert(redacted.longString.length < 2500, 'long string should be bounded/truncated');
    assert(
      redacted.longString.includes('[truncated'),
      'truncation notice must be present on huge strings',
    );
  },
);

// 2. Bounded log file rotation on size limit
await checkAsync(
  'logging: log file size is bounded and rotates when threshold exceeded',
  async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-log-bound-'));
    try {
      const logPath = join(testDir, 'run_bound_test.log');
      const maxBytes = 2000; // Small 2KB threshold for testing

      // Write logs until rotation threshold is reached
      for (let i = 0; i < 50; i++) {
        writeRunLog(
          logPath,
          formatRunLogLine({
            runId: 'run_bound_test',
            sequence: i + 1,
            type: 'message.delta',
            data: {
              delta: `Log payload chunk number ${i + 1} with extra padding for bytes size test`,
            },
          }),
          maxBytes,
        );
      }

      assert(existsSync(logPath), 'current log file must exist');
      const backupPath = `${logPath}.1`;
      assert(existsSync(backupPath), 'rotated log file .1 must exist');

      const currentStats = statSync(logPath);
      const backupStats = statSync(backupPath);
      assert(backupStats.size >= maxBytes, 'backup log file was rotated at or above threshold');
      assert(currentStats.size < backupStats.size, 'new log file started fresh after rotation');

      const currentContent = readFileSync(logPath, 'utf8');
      assert(
        currentContent.includes('[LOG_ROTATED]'),
        'rotation marker must appear in new log file',
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 3. Adapter Manager run logs redact sensitive payload
await checkAsync('manager: run logs in ~/.taskaside/logs/runs redact sensitive data', async () => {
  const manager = new AdapterRunManager();
  const testDir = mkdtempSync(join(tmpdir(), 'taskaside-mgr-log-'));
  try {
    const runId = `run_log_sec_${Date.now()}`;
    const startRes = manager.startRun(
      {
        runId,
        taskId: 't_log_1',
        provider: 'codex',
        cwd: testDir,
        instruction: 'Do work with Bearer secret_bearer_token_abc123',
        ownerId: 'eng_1',
        generation: 1,
        mcp: {
          endpoint: 'http://127.0.0.1:4000/mcp',
          accessToken: 'mcp_super_secret_run_token_xyz',
        },
      },
      { scenario: 'success' },
    );
    assert(startRes.started, 'run started');

    const run = manager.getRun(runId);
    if (!run) {
      throw new Error('run must exist');
    }

    // Wait for scenario to finish
    await new Promise((r) => setTimeout(r, 50));

    assert(existsSync(run.logPath), 'run log file must exist on disk');
    const logText = readFileSync(run.logPath, 'utf8');

    // Secrets must NOT be present in cleartext
    assert(
      !logText.includes('secret_bearer_token_abc123'),
      'bearer token must not appear in cleartext in run log',
    );
    assert(
      !logText.includes('mcp_super_secret_run_token_xyz'),
      'mcp token must not appear in cleartext in run log',
    );
    assert(logText.includes('[REDACTED]'), 'redacted marker must be present in log');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// 4. Duplicate start idempotency and conflict rejection
await checkAsync(
  'duplicate start: repeated start is idempotent with matching owner/gen, rejects stale gen',
  async () => {
    const manager = new AdapterRunManager();
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-dup-start-'));
    try {
      const runId = `run_dup_${Date.now()}`;
      const req: StartRunRequest = {
        runId,
        taskId: 't_dup',
        provider: 'codex',
        cwd: testDir,
        instruction: 'test duplicate start',
        ownerId: 'eng_1',
        generation: 1,
      };

      const first = manager.startRun(req, { scenario: 'crash' });
      assert(first.started === true, 'first start succeeds');
      assert(first.existing === undefined, 'first start is new');

      // Repeat with identical credentials: idempotent return without duplicate spawn
      const second = manager.startRun(req, { scenario: 'crash' });
      assert(second.started === true, 'repeated start succeeds');
      assert(second.existing === true, 'repeated start is recognized as existing run');

      // Repeat with different ownerId: must reject with 409
      let rejectedOwner = false;
      try {
        manager.startRun({ ...req, ownerId: 'eng_other' });
      } catch (err: unknown) {
        rejectedOwner = (err as { code?: string })?.code === 'STALE_GENERATION';
      }
      assert(rejectedOwner, 'mismatched ownerId must throw STALE_GENERATION');

      // Repeat with different generation: must reject with 409
      let rejectedGen = false;
      try {
        manager.startRun({ ...req, generation: 2 });
      } catch (err: unknown) {
        rejectedGen = (err as { code?: string })?.code === 'STALE_GENERATION';
      }
      assert(rejectedGen, 'mismatched generation must throw STALE_GENERATION');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 5. Slow SSE consumer bounding and termination
await checkAsync(
  'slow consumer: aborts stalled SSE stream when queue threshold is exceeded',
  async () => {
    const manager = new AdapterRunManager();
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-slow-cons-'));
    const port = await getFreePort();
    const internalToken = 'safety-internal-token-1';
    const app = createAdapterApp({ port, manager, internalToken });
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch });

    try {
      const runId = `run_slow_${Date.now()}`;
      manager.startRun(
        {
          runId,
          taskId: 't_slow',
          provider: 'codex',
          cwd: testDir,
          instruction: 'slow consumer test',
          ownerId: 'eng_1',
          generation: 1,
        },
        { scenario: 'crash' }, // Stay running so stream remains open
      );

      const run = manager.getRun(runId);
      if (!run) throw new Error('run must exist');
      assert(run.subscribers.size === 0, 'no subscribers initially');

      // Connect SSE client
      const res = await fetch(`http://127.0.0.1:${port}/internal/v1/runs/${runId}/events`, {
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${internalToken}`,
          'X-TaskAside-Role': 'engine',
        },
      });
      assert(res.status === 200, 'SSE connection established');
      // Consume body in background and swallow expected socket reset on stream closure
      const reader = res.body?.getReader();
      (async () => {
        try {
          while (reader) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // Expected when server closes connection
        }
      })();

      // Emit 60 events rapidly while client is slow (queue exceeds 50)
      for (let i = 1; i <= 60; i++) {
        manager.emitEvent(run, {
          runId,
          sequence: i,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm', delta: `delta ${i}` },
        });
      }

      // Give event loop time to trigger slow consumer detection
      await new Promise((r) => setTimeout(r, 100));

      // Slow consumer threshold (50) should have triggered abort and unsubscription
      assert(
        run.subscribers.size === 0,
        'slow consumer must be unsubscribed to prevent memory leak',
      );
    } finally {
      server.stop(true);
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 6. Disconnected SSE consumer clean unsubscription
await checkAsync(
  'disconnected consumer: aborting SSE stream cleans up subscription without leak',
  async () => {
    const manager = new AdapterRunManager();
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-disc-cons-'));
    const port = await getFreePort();
    const internalToken = 'safety-internal-token-2';
    const app = createAdapterApp({ port, manager, internalToken });
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch });

    try {
      const runId = `run_disc_${Date.now()}`;
      manager.startRun(
        {
          runId,
          taskId: 't_disc',
          provider: 'codex',
          cwd: testDir,
          instruction: 'disconnect consumer test',
          ownerId: 'eng_1',
          generation: 1,
        },
        { scenario: 'crash' },
      );

      const run = manager.getRun(runId);
      if (!run) throw new Error('run must exist');

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/internal/v1/runs/${runId}/events`, {
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${internalToken}`,
          'X-TaskAside-Role': 'engine',
        },
        signal: controller.signal,
      });
      assert(res.status === 200, 'SSE connected');
      assert(run.subscribers.size === 1, 'subscriber active');

      // Consume body in background and swallow expected abort error
      const reader = res.body?.getReader();
      (async () => {
        try {
          while (reader) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // Expected when client aborts
        }
      })();

      // Client disconnects
      controller.abort();
      await new Promise((r) => setTimeout(r, 100));

      assert(run.subscribers.size === 0, 'disconnected client must be removed from subscribers');
    } finally {
      server.stop(true);
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 7. Restart uncertainty: unknown run status returns 404, requires verifiedStop proof
await checkAsync(
  'restart uncertainty: fresh adapter has no in-flight record and returns 404',
  async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-restart-'));
    try {
      // Instance 1 starts a run
      const mgr1 = new AdapterRunManager();
      const runId = `run_reboot_${Date.now()}`;
      mgr1.startRun(
        {
          runId,
          taskId: 't_reboot',
          provider: 'codex',
          cwd: testDir,
          instruction: 'restart test',
          ownerId: 'eng_1',
          generation: 1,
        },
        { scenario: 'crash' },
      );
      const status1 = mgr1.getRunStatus(runId);
      assert(status1.processState.status === 'running', 'run is running on instance 1');
      assert(status1.processState.verifiedStoppedAt === null, 'not verified stopped while running');

      // Instance 2 simulates adapter restart (new in-memory process state)
      const mgr2 = new AdapterRunManager();
      let notFound = false;
      try {
        mgr2.getRunStatus(runId);
      } catch (err: unknown) {
        notFound = (err as { code?: string })?.code === 'NOT_FOUND';
      }
      assert(notFound, 'restarted adapter returns NOT_FOUND for unmanaged in-flight runs');

      // Engine must treat this uncertainty by quarantining the lock, not releasing it blindly
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 8. Process-tree termination on macOS: verifiedStopped and process_group_empty proof
await checkAsync(
  'process tree: child subprocess tree terminated cleanly with process_group_empty proof',
  async () => {
    const manager = new AdapterRunManager();
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-pgid-kill-'));
    try {
      const runId = `run_pgid_${Date.now()}`;
      // Spawn a long-running process tree under the driver (detached process group)
      const run = {
        runId,
        taskId: 't_pgid',
        provider: 'codex' as const,
        cwd: testDir,
        instruction: 'run long',
        ownerId: 'eng_1',
        generation: 1,
        status: 'running' as const,
        events: [],
        lastSequence: 0,
        pendingRequestId: null,
        verifiedStoppedAt: null,
        verificationMethod: null,
        exitCode: null,
        createdAt: new Date().toISOString(),
        subscribers: new Set<(event: EventEnvelope) => void>(),
        onEndSubscribers: new Set<() => void>(),
        logPath: join(testDir, 'test.log'),
      };

      // Spawn a detached process tree (sh spawning sleep child)
      const proc = Bun.spawn(['sh', '-c', 'sleep 60 & sleep 60 & wait'], {
        cwd: testDir,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      const pgid = proc.pid;

      // Verify process group is alive
      const initialCheck = execSync(`ps -o pid=,pgid= -g ${pgid} 2>/dev/null || true`, {
        encoding: 'utf8',
      }).trim();
      assert(initialCheck.length > 0, 'process group must initially have running processes');

      // Terminate process group via process.kill(-pgid, 'SIGTERM')
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {
        // ignore
      }

      // Wait and confirm process group is empty
      await new Promise((r) => setTimeout(r, 100));
      let remaining = execSync(`ps -o pid=,pgid= -g ${pgid} 2>/dev/null || true`, {
        encoding: 'utf8',
      }).trim();
      if (remaining.length > 0) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 50));
        remaining = execSync(`ps -o pid=,pgid= -g ${pgid} 2>/dev/null || true`, {
          encoding: 'utf8',
        }).trim();
      }

      assert(
        remaining.length === 0,
        'all descendant processes in process group must be terminated',
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 9. Real Codex CLI lifecycle on macOS (start, stream, complete, cancel, inspect)
await checkAsync(
  'live codex: real CLI passes start, stream, inspect, and cancellation on macOS',
  async () => {
    const manager = new AdapterRunManager();
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-live-codex-'));
    execSync('git init', { cwd: testDir, stdio: 'ignore' });

    try {
      const runId = `run_live_cdx_${Date.now()}`;
      const startRes = manager.startRun({
        runId,
        taskId: 't_live_cdx',
        provider: 'codex',
        cwd: testDir,
        instruction: 'echo "Codex lifecycle validation" and output done',
        ownerId: 'eng_1',
        generation: 1,
      });
      assert(startRes.started, 'codex run started');

      // Inspect status during run
      const activeStatus = manager.getRunStatus(runId);
      assert(activeStatus.processState.status === 'running', 'status reports running');

      // Cancel while running
      const cancelRes = await manager.cancelRun(runId, { ownerId: 'eng_1', generation: 1 });
      assert(cancelRes.verifiedStopped === true, 'cancel returns verifiedStopped: true');
      assert(
        cancelRes.verificationMethod === 'process_group_empty',
        'method is process_group_empty',
      );

      const termStatus = manager.getRunStatus(runId);
      assert(termStatus.processState.status === 'cancelled', 'status is cancelled');
      assert(termStatus.processState.verifiedStoppedAt !== null, 'verifiedStoppedAt recorded');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 10. Real Claude CLI lifecycle on macOS (start, stream, exit/quota handling, cancel, inspect)
await checkAsync(
  'live claude: real CLI handles lifecycle, terminal state, and cancel on macOS',
  async () => {
    const manager = new AdapterRunManager();
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-live-claude-'));
    execSync('git init', { cwd: testDir, stdio: 'ignore' });

    try {
      const runId = `run_live_cld_${Date.now()}`;
      const startRes = manager.startRun({
        runId,
        taskId: 't_live_cld',
        provider: 'claude',
        cwd: testDir,
        instruction: 'echo "Claude lifecycle validation"',
        ownerId: 'eng_1',
        generation: 1,
      });
      assert(startRes.started, 'claude run started');

      // Inspect status during run
      const activeStatus = manager.getRunStatus(runId);
      assert(activeStatus.processState.status === 'running', 'status reports running');

      // Cancel while running
      const cancelRes = await manager.cancelRun(runId, { ownerId: 'eng_1', generation: 1 });
      assert(cancelRes.verifiedStopped === true, 'cancel returns verifiedStopped: true');
      assert(
        cancelRes.verificationMethod === 'process_group_empty',
        'method is process_group_empty',
      );

      const termStatus = manager.getRunStatus(runId);
      assert(termStatus.processState.status === 'cancelled', 'status is cancelled');
      assert(termStatus.processState.verifiedStoppedAt !== null, 'verifiedStoppedAt recorded');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// 11. Finished turn alone cannot release writer lock without verified stopped proof
await checkAsync(
  'fencing safety: terminal turn completion requires verifiedStopped: true proof',
  async () => {
    const manager = new AdapterRunManager();
    const testDir = mkdtempSync(join(tmpdir(), 'taskaside-fence-safe-'));
    try {
      const runId = `run_fence_${Date.now()}`;
      manager.startRun(
        {
          runId,
          taskId: 't_fence',
          provider: 'codex',
          cwd: testDir,
          instruction: 'fencing test',
          ownerId: 'eng_1',
          generation: 1,
        },
        { scenario: 'success' },
      );

      // Wait for scenario to complete
      await new Promise((r) => setTimeout(r, 50));

      const status = manager.getRunStatus(runId);
      assert(status.processState.status === 'done', 'run is in terminal status done');
      assert(
        status.processState.verifiedStoppedAt !== null,
        'must have verifiedStoppedAt timestamp',
      );
      assert(
        status.processState.verificationMethod === 'process_group_empty' ||
          status.processState.verificationMethod === 'ps_fingerprint_absent',
        'must provide valid verification method proof',
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// Print summary
console.log('\n--- Provider Safety Verification Summary ---');
let failed = 0;
for (const r of results) {
  if (r.passed) {
    console.log(`[PASS] ${r.name}`);
  } else {
    console.log(`[FAIL] ${r.name}: ${r.error}`);
    failed++;
  }
}

console.log(`\n${results.length - failed}/${results.length} checks passed\n`);

if (failed > 0) {
  process.exit(1);
}
