// Distribution and packaging verification suite (TASKS.md T29, ARCHITECTURE.md §10, SPECIFICATION.md §8).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installPayload, resolveAppDataDir, resolveBunPath } from '../../bin/taskaside.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');

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

console.log('--- TaskAside Distribution & Package Verification (T29) ---\n');

// 1. Build Verification: build script produces dist/frontend and dist/services
await check('build: compiles frontend bundle and services bundles into dist/', () => {
  const buildRes = spawnSync('bun', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert(buildRes.status === 0, `bun run build failed: ${buildRes.stderr}`);

  assert(existsSync(join(REPO_ROOT, 'dist', 'frontend', 'index.html')), 'dist/frontend/index.html must exist');
  assert(existsSync(join(REPO_ROOT, 'dist', 'services', 'backend.js')), 'dist/services/backend.js must exist');
  assert(existsSync(join(REPO_ROOT, 'dist', 'services', 'agent-adapter.js')), 'dist/services/agent-adapter.js must exist');
  assert(existsSync(join(REPO_ROOT, 'dist', 'services', 'execution-engine.js')), 'dist/services/execution-engine.js must exist');
  assert(existsSync(join(REPO_ROOT, 'dist', 'services', 'cli.js')), 'dist/services/cli.js must exist');
});

// 2. Package manifest verification: bin and files fields
await check('package.json: defines bin/taskaside.js and restricts published files to bin/ and dist/', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert(pkg.bin?.taskaside === './bin/taskaside.js', 'package.json must declare bin.taskaside');
  assert(Array.isArray(pkg.files), 'package.json must declare files array');
  assert(pkg.files.includes('bin'), 'files must include bin');
  assert(pkg.files.includes('dist'), 'files must include dist');
  assert(!pkg.files.includes('src'), 'files MUST NOT include src');
  assert(!pkg.files.includes('specs'), 'files MUST NOT include specs');
});

// 3. Lean tarball dry-run verification
await check('pack: npm pack --dry-run excludes development sources, test checks, and scratch folders', () => {
  const packRes = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert(packRes.status === 0, `npm pack --dry-run failed: ${packRes.stderr}`);
  const packInfo = JSON.parse(packRes.stdout);
  const files: { path: string }[] = packInfo[0]?.files ?? [];
  const filePaths = files.map((f) => f.path);

  // Must include bin and dist
  assert(filePaths.includes('bin/taskaside.js'), 'tarball must include bin/taskaside.js');
  assert(filePaths.includes('dist/frontend/index.html'), 'tarball must include dist/frontend/index.html');
  assert(filePaths.includes('dist/services/backend.js'), 'tarball must include dist/services/backend.js');

  // Must not include src/, specs/, or tests
  for (const fp of filePaths) {
    assert(!fp.startsWith('src/'), `tarball must not include src/ file: ${fp}`);
    assert(!fp.startsWith('specs/'), `tarball must not include specs/ file: ${fp}`);
    assert(!fp.includes('.taskaside-implementation'), `tarball must not include scratch: ${fp}`);
    assert(!fp.endsWith('-checks.ts'), `tarball must not include test checks: ${fp}`);
  }
});

// 4. Launcher Bun resolution
await check('launcher: resolveBunPath finds valid bun executable', () => {
  const bunPath = resolveBunPath();
  assert(typeof bunPath === 'string' && bunPath.length > 0, 'resolveBunPath must return path to bun');
  const checkBun = spawnSync(bunPath ?? 'bun', ['--version'], { stdio: 'pipe' });
  assert(checkBun.status === 0, 'bun executable must answer --version with 0');
});

// 5. Payload install into isolated stable app data directory
const isolatedDataDir = mkdtempSync(join(tmpdir(), 'taskaside-dist-test-'));
const simulatedNpxCache = mkdtempSync(join(tmpdir(), 'taskaside-npx-sim-'));

try {
  let installedPayloadDir = '';

  await check('launcher: installPayload copies versioned payload into stable app data directory', () => {
    installedPayloadDir = installPayload(isolatedDataDir);
    assert(existsSync(installedPayloadDir), 'installed payload directory must exist');
    assert(existsSync(join(installedPayloadDir, 'package.json')), 'payload package.json must exist');
    assert(existsSync(join(installedPayloadDir, 'dist', 'services', 'cli.js')), 'payload cli.js must exist');
    assert(existsSync(join(installedPayloadDir, 'dist', 'frontend', 'index.html')), 'payload index.html must exist');
  });

  // 6. Start from simulated ephemeral npx cache
  const launcherScript = join(REPO_ROOT, 'bin', 'taskaside.js');
  const baseEnv = {
    ...process.env,
    TASKASIDE_DATA_DIR: isolatedDataDir,
    TASKASIDE_BUN_PATH: resolveBunPath() ?? 'bun',
  };

  let backendPort = 0;

  await check('lifecycle: node bin/taskaside.js start starts detached supervisor and services', async () => {
    const startRes = spawnSync('node', [launcherScript, 'start'], {
      cwd: simulatedNpxCache,
      env: baseEnv,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    assert(startRes.status === 0, `start command failed: ${startRes.stderr} (stdout: ${startRes.stdout})`);
    assert(startRes.stdout.includes('backend: running'), `start output must show backend running: ${startRes.stdout}`);
    assert(startRes.stdout.includes('agent-adapter: running'), `start output must show agent-adapter running: ${startRes.stdout}`);
    assert(startRes.stdout.includes('execution-engine: running'), `start output must show execution-engine running: ${startRes.stdout}`);

    // Parse backend port from supervisor lockfile
    const lockPath = join(isolatedDataDir, 'supervisor.json');
    assert(existsSync(lockPath), 'supervisor.json must exist in data directory');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    backendPort = lock.services.backend.port;
    assert(backendPort > 0, 'backend port must be valid');

    // Health check on backend port
    const healthRes = await fetch(`http://127.0.0.1:${backendPort}/health`);
    assert(healthRes.status === 200, 'backend /health must return 200');
    const healthJson = (await healthRes.json()) as { status: string; service: string };
    assert(healthJson.status === 'ok' && healthJson.service === 'backend', 'backend health payload must match');

    // Frontend index.html served from payload
    const indexRes = await fetch(`http://127.0.0.1:${backendPort}/`);
    assert(indexRes.status === 200, 'backend must serve root frontend index.html');
    const indexHtml = await indexRes.text();
    assert(indexHtml.includes('TaskAside'), 'served html must contain TaskAside title');
  });

  // 7. Total purge of ephemeral cache does not affect running services
  await check('resilience: total purge of simulated ephemeral npx cache leaves detached supervisor running', async () => {
    rmSync(simulatedNpxCache, { recursive: true, force: true });
    assert(!existsSync(simulatedNpxCache), 'simulated npx cache must be completely removed');

    // Services must still be healthy and responding
    const healthRes = await fetch(`http://127.0.0.1:${backendPort}/health`);
    assert(healthRes.status === 200, 'backend must remain healthy after cache purge');

    // Status query from an entirely separate clean invocation directory
    const cleanDir = mkdtempSync(join(tmpdir(), 'taskaside-clean-invoke-'));
    try {
      const statusRes = spawnSync('node', [launcherScript, 'status'], {
        cwd: cleanDir,
        env: baseEnv,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      assert(statusRes.status === 0, `status command failed: ${statusRes.stderr}`);
      assert(statusRes.stdout.includes('backend: running'), `status output must show backend running: ${statusRes.stdout}`);
      assert(statusRes.stdout.includes('agent-adapter: running'), `status output must show agent-adapter running: ${statusRes.stdout}`);
      assert(statusRes.stdout.includes('execution-engine: running'), `status output must show execution-engine running: ${statusRes.stdout}`);
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  // 8. Clean stop terminates all services
  await check('lifecycle: node bin/taskaside.js stop cleanly terminates all 3 service processes', async () => {
    const cleanDir = mkdtempSync(join(tmpdir(), 'taskaside-stop-invoke-'));
    try {
      const stopRes = spawnSync('node', [launcherScript, 'stop'], {
        cwd: cleanDir,
        env: baseEnv,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      assert(stopRes.status === 0, `stop command failed: ${stopRes.stderr}`);
      assert(stopRes.stdout.includes('taskaside stopped'), `stop output must report stopped: ${stopRes.stdout}`);

      // Verify lockfile removed
      const lockPath = join(isolatedDataDir, 'supervisor.json');
      assert(!existsSync(lockPath), 'supervisor.json must be removed after stop');

      // Verify backend is no longer responding
      let reached = false;
      try {
        await fetch(`http://127.0.0.1:${backendPort}/health`, { signal: AbortSignal.timeout(500) });
        reached = true;
      } catch {
        // Connection refused as expected
      }
      assert(!reached, 'backend must no longer accept connections after stop');
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });
} finally {
  rmSync(isolatedDataDir, { recursive: true, force: true });
}

// Summary
const failed = results.filter((r) => !r.passed);
console.log(`\nDistribution Verification Results: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error('Failed checks:', failed);
  process.exit(1);
}
process.exit(0);
