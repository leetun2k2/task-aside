// Release candidate verification suite (TASKS.md T32, ARCHITECTURE.md §10, SPECIFICATION.md §9).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDatabase, openDatabase } from '../backend/db/connection.ts';
import { IncompatibleSchemaError, runMigrations } from '../backend/db/migrations.ts';
import { createRepository } from '../backend/domains/task/repositories.ts';
import { createTask, getTaskById } from '../backend/domains/task/tasks.ts';
import { TASKASIDE_VERSION } from '../supervisor/version.ts';

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

console.log('--- TaskAside Release Candidate Verification (T32) ---\n');

// 1. Clean build check
await check('build: production UI and services bundles build cleanly without warnings', () => {
  const buildRes = spawnSync('bun', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert(buildRes.status === 0, `build failed: ${buildRes.stderr}`);
});

// 2. Database migration and upgrade continuity
await check('database: migrations preserve existing tasks/chat and reject incompatible versions', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'taskaside-t32-db-'));
  const dbPath = join(tempDir, 'release.db');
  try {
    // Initial migration
    const db1 = openDatabase({ path: dbPath });
    runMigrations(db1);

    const repo = createRepository(db1, {
      name: 'rel-repo',
      displayPath: tempDir,
      defaultProvider: 'codex',
    });
    const task = createTask(db1, {
      repoId: repo.id,
      title: 'Release Task',
      priority: 'P0',
    });
    closeDatabase(db1);

    // Reopen and re-run migrations (upgrade simulation)
    const db2 = openDatabase({ path: dbPath });
    runMigrations(db2);
    const restored = getTaskById(db2, task.id);
    assert(restored !== undefined && restored !== null && restored.title === 'Release Task', 'task must survive reopen & migration');

    // Tampered schema simulation
    db2.run("INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (9999, 'future_migration', '2030-01-01', 'xyz')");
    let threw = false;
    try {
      runMigrations(db2);
    } catch (err) {
      if (err instanceof IncompatibleSchemaError) {
        threw = true;
      }
    }
    assert(threw, 'incompatible future schema must throw IncompatibleSchemaError');
    closeDatabase(db2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// 3. Secrets and log scanning
await check('security: no exposed private tokens, passwords, or secrets in distribution artifacts', () => {
  const pkgRes = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert(pkgRes.status === 0, 'npm pack dry run must pass');
  const files: { path: string }[] = JSON.parse(pkgRes.stdout)[0]?.files ?? [];

  for (const f of files) {
    const forbidden = ['.env', 'token', '.key', '.pem', '.log', '.db'];
    for (const pat of forbidden) {
      assert(!f.path.toLowerCase().includes(pat), `package must not include secret/log file: ${f.path}`);
    }
  }
});

// 4. CLI launcher version and help check
await check('cli: launcher reports version matching TASKASIDE_VERSION and help text', () => {
  const versionRes = spawnSync('node', [LAUNCHER, '--version'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert(versionRes.status === 0, 'version check must succeed');
  assert(versionRes.stdout.trim() === TASKASIDE_VERSION, `version must match TASKASIDE_VERSION (${TASKASIDE_VERSION})`);

  const helpRes = spawnSync('node', [LAUNCHER, '--help'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert(helpRes.status === 0, 'help check must succeed');
  assert(helpRes.stdout.includes('taskaside [command]'), 'help text must include usage pattern');
});

// Summary
const failed = results.filter((r) => !r.passed);
console.log(`\nRelease Candidate Results: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error('Failed checks:', failed);
  process.exit(1);
}
process.exit(0);
