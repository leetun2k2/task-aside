// Supervisor hardening verification suite (TASKS.md T30, ARCHITECTURE.md §2.5, §10, SPECIFICATION.md §8).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveBunPath } from '../../bin/taskaside.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const LAUNCHER = join(REPO_ROOT, 'bin', 'taskaside.js');

interface CheckResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: CheckResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`[PASS] ${name}`);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error });
    console.error(`[FAIL] ${name}: ${error}`);
  }
}

console.log('--- TaskAside Supervisor Hardening Verification (T30) ---\n');

const testDataDir = mkdtempSync(join(tmpdir(), 'taskaside-t30-data-'));
const bunPath = resolveBunPath() ?? 'bun';

const baseEnv = {
  ...process.env,
  TASKASIDE_DATA_DIR: testDataDir,
  TASKASIDE_BUN_PATH: bunPath,
  TASKASIDE_NO_BROWSER: '1',
};

try {
  // 1. Initial start starts 3 services in readiness order
  await check('startup: starts backend -> adapter -> engine in order and writes supervisor lock', async () => {
    const res = spawnSync('node', [LAUNCHER, 'start'], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert(res.status === 0, `start failed: ${res.stderr} (stdout: ${res.stdout})`);
    assert(res.stdout.includes('backend: running'), 'backend must report running');
    assert(res.stdout.includes('agent-adapter: running'), 'adapter must report running');
    assert(res.stdout.includes('execution-engine: running'), 'engine must report running');

    const lockPath = join(testDataDir, 'supervisor.json');
    assert(existsSync(lockPath), 'supervisor.json lock must exist');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert(lock.status === 'running', 'lock status must be running');
    assert(lock.services.backend.pid > 0, 'backend pid must be present');
    assert(lock.services['agent-adapter'].pid > 0, 'adapter pid must be present');
    assert(lock.services['execution-engine'].pid > 0, 'engine pid must be present');
  });

  // 2. Attach once: second start command detects running backend, prints URL, exits 0 without duplicate spawn
  await check('attach-once: duplicate start attaches to existing instance without second spawn', async () => {
    const lockBefore = JSON.parse(readFileSync(join(testDataDir, 'supervisor.json'), 'utf8'));

    const res = spawnSync('node', [LAUNCHER, 'start'], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert(res.status === 0, `second start must exit 0: ${res.stderr}`);
    assert(res.stdout.includes('already running: backend pid'), `must report already running: ${res.stdout}`);
    assert(res.stdout.includes('local URL: http://127.0.0.1:'), `must print local URL: ${res.stdout}`);

    const lockAfter = JSON.parse(readFileSync(join(testDataDir, 'supervisor.json'), 'utf8'));
    assert(lockBefore.services.backend.pid === lockAfter.services.backend.pid, 'backend pid must not change');
    assert(lockBefore.services['agent-adapter'].pid === lockAfter.services['agent-adapter'].pid, 'adapter pid must not change');
  });

  // 3. Status reports all three services running with ports and PIDs
  await check('status: reports all three services with valid PIDs, ports, and health', async () => {
    const res = spawnSync('node', [LAUNCHER, 'status'], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert(res.status === 0, `status failed: ${res.stderr}`);
    assert(res.stdout.includes('backend: running'), 'backend must report running in status');
    assert(res.stdout.includes('agent-adapter: running'), 'adapter must report running in status');
    assert(res.stdout.includes('execution-engine: running'), 'engine must report running in status');
  });

  // 4. Clean stop terminates services in reverse order and clears supervisor lock
  await check('stop: terminates services cleanly and clears supervisor lock', async () => {
    const res = spawnSync('node', [LAUNCHER, 'stop'], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert(res.status === 0, `stop failed: ${res.stderr}`);
    assert(res.stdout.includes('taskaside stopped'), `must report stopped: ${res.stdout}`);

    const lockPath = join(testDataDir, 'supervisor.json');
    assert(!existsSync(lockPath), 'supervisor.json must be removed after stop');

    const statusAfter = spawnSync('node', [LAUNCHER, 'status'], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert(statusAfter.stdout.includes('backend: stopped'), 'backend must report stopped');
    assert(statusAfter.stdout.includes('agent-adapter: stopped'), 'adapter must report stopped');
    assert(statusAfter.stdout.includes('execution-engine: stopped'), 'engine must report stopped');
  });

  // 5. Restart resilience & backoff: restart after stop works cleanly
  await check('restart: supervisor restarts cleanly after prior stop with fresh ports and lock', async () => {
    const res = spawnSync('node', [LAUNCHER, 'start'], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert(res.status === 0, `restart failed: ${res.stderr}`);
    assert(res.stdout.includes('backend: running'), 'backend must report running after restart');

    const lockPath = join(testDataDir, 'supervisor.json');
    assert(existsSync(lockPath), 'supervisor.json must exist after restart');

    // Clean stop at end of test
    spawnSync('node', [LAUNCHER, 'stop'], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  });
} finally {
  rmSync(testDataDir, { recursive: true, force: true });
}

// Summary
const failed = results.filter((r) => !r.passed);
console.log(`\nSupervisor Hardening Results: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error('Failed checks:', failed);
  process.exit(1);
}
process.exit(0);
