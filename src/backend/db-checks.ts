// Automated database lifecycle verification suite (T10).
// Run: bun run src/backend/db-checks.ts
import type { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { closeDatabase, openDatabase } from './db/connection.ts';
import { IncompatibleSchemaError, runMigrations } from './db/migrations.ts';

type CheckResult = { name: string; passed: boolean; error?: string };
const results: CheckResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(
  fn: () => void,
  errorType: new (...args: never[]) => Error,
  message: string,
): void {
  try {
    fn();
  } catch (err) {
    assert(
      err instanceof errorType,
      `${message} (threw ${String(err)}, expected ${errorType.name})`,
    );
    return;
  }
  throw new Error(`${message} (did not throw)`);
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function pragma(db: Database, name: string): string {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  if (!row) {
    throw new Error(`PRAGMA ${name} returned no row`);
  }
  return String(Object.values(row)[0]);
}

const workDir = mkdtempSync(join(tmpdir(), 'taskaside-db-checks-'));
const dbPath = join(workDir, 'taskaside.db');

function main(): void {
  const db = openDatabase({ path: dbPath });
  try {
    // --- 1. Migration execution on fresh database --------------------------
    check('migration: runs on a fresh database', () => {
      runMigrations(db);
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const expected of [
        'repositories',
        'tasks',
        'runs',
        'run_locks',
        'run_event_receipts',
        'conversations',
        'messages',
        '_migrations',
      ]) {
        assert(
          tables.includes(expected),
          `expected table ${expected} to exist, found: ${tables.join(', ')}`,
        );
      }
    });

    // --- 2. WAL mode verification -------------------------------------------
    check('pragma: journal_mode is wal', () => {
      assert(pragma(db, 'journal_mode').toLowerCase() === 'wal', 'expected journal_mode = wal');
    });

    // --- 3. Foreign key enforcement -----------------------------------------
    check('pragma: foreign_keys is active', () => {
      assert(pragma(db, 'foreign_keys') === '1', 'expected foreign_keys pragma to be 1');
    });

    check('fk: invalid repository_id on tasks insert is rejected', () => {
      assertThrows(
        () => {
          db.query(
            `INSERT INTO tasks
              (id, repository_id, conversation_id, parent_id, title, description, priority, status,
               agent_provider, block_kind, blocked_reason, depth, blocked_on_child_ids, origin_run_id,
               origin_key, created_at, enqueued_at, updated_at)
             VALUES ('t-bad-fk', 'missing-repo', 'missing-conv', NULL, 'bad', NULL, 'P2', 'todo',
               'codex', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-18T00:00:00Z', '2026-10-18T00:00:00Z',
               '2026-10-18T00:00:00Z')`,
          ).run();
        },
        Error,
        'expected FK violation on invalid repository_id/conversation_id',
      );
    });

    // --- 4. Indexes and dedup receipts --------------------------------------
    const now = '2026-10-18T00:00:00Z';

    db.query(
      'INSERT INTO repositories (id, name, display_path, canonical_path, default_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('repo-1', 'demo', '/tmp/demo', '/tmp/demo', 'codex', now);

    check('dedup: duplicate repositories.canonical_path is rejected', () => {
      assertThrows(
        () => {
          db.query(
            'INSERT INTO repositories (id, name, display_path, canonical_path, default_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run('repo-2', 'demo-2', '/tmp/demo', '/tmp/demo', 'codex', now);
        },
        Error,
        'expected UNIQUE violation on repositories.canonical_path',
      );
    });

    db.query('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(
      'conv-1',
      now,
      now,
    );
    db.query(
      `INSERT INTO tasks
        (id, repository_id, conversation_id, parent_id, title, description, priority, status,
         agent_provider, block_kind, blocked_reason, depth, blocked_on_child_ids, origin_run_id,
         origin_key, created_at, enqueued_at, updated_at)
       VALUES ('task-1', 'repo-1', 'conv-1', NULL, 'Demo task', NULL, 'P2', 'todo',
         'codex', NULL, NULL, 0, NULL, 'run-origin-1', 'child-key-1', ?, ?, ?)`,
    ).run(now, now, now);

    check('dedup: duplicate tasks(origin_run_id, origin_key) is rejected', () => {
      assertThrows(
        () => {
          db.query(
            `INSERT INTO tasks
              (id, repository_id, conversation_id, parent_id, title, description, priority, status,
               agent_provider, block_kind, blocked_reason, depth, blocked_on_child_ids, origin_run_id,
               origin_key, created_at, enqueued_at, updated_at)
             VALUES ('task-2', 'repo-1', 'conv-1', NULL, 'Duplicate child', NULL, 'P2', 'todo',
               'codex', NULL, NULL, 0, NULL, 'run-origin-1', 'child-key-1', ?, ?, ?)`,
          ).run(now, now, now);
        },
        Error,
        'expected UNIQUE violation on tasks(origin_run_id, origin_key)',
      );
    });

    db.query(
      `INSERT INTO runs
        (id, task_id, provider, provider_session_id, status, owner_token, lock_generation,
         process_state, pending_input_request_id, log_path, started_at, heartbeat_at, ended_at, exit_code)
       VALUES ('run-1', 'task-1', 'codex', NULL, 'running', 'owner-1', 1, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
    ).run(now, now);

    db.query(
      'INSERT INTO run_event_receipts (run_id, sequence, event_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run('run-1', 1, 'hash-1', now);

    check('dedup: duplicate run_event_receipts(run_id, sequence) is rejected', () => {
      assertThrows(
        () => {
          db.query(
            'INSERT INTO run_event_receipts (run_id, sequence, event_hash, created_at) VALUES (?, ?, ?, ?)',
          ).run('run-1', 1, 'hash-2', now);
        },
        Error,
        'expected PRIMARY KEY violation on run_event_receipts(run_id, sequence)',
      );
    });

    db.query(
      `INSERT INTO messages
        (id, conversation_id, role, content, in_reply_to_request_id, source_run_id, source_event_seq, created_at)
       VALUES ('msg-1', 'conv-1', 'agent', 'hello', NULL, 'run-1', 1, ?)`,
    ).run(now);

    check('dedup: duplicate messages(source_run_id, source_event_seq) is rejected', () => {
      assertThrows(
        () => {
          db.query(
            `INSERT INTO messages
              (id, conversation_id, role, content, in_reply_to_request_id, source_run_id, source_event_seq, created_at)
             VALUES ('msg-2', 'conv-1', 'agent', 'hello again', NULL, 'run-1', 1, ?)`,
          ).run(now);
        },
        Error,
        'expected UNIQUE violation on messages(source_run_id, source_event_seq)',
      );
    });

    // --- 5. Persistent lock generation ---------------------------------------
    check('run_locks: write and read back generation and quarantine state', () => {
      db.query(
        `INSERT INTO run_locks
          (working_tree_key, owner_run_id, generation, lease_expires_at, quarantined,
           quarantined_reason, quarantined_at, updated_at)
         VALUES ('/tmp/demo', 'run-1', 1, ?, 0, NULL, NULL, ?)`,
      ).run(now, now);

      const row = db
        .query('SELECT generation, quarantined FROM run_locks WHERE working_tree_key = ?')
        .get('/tmp/demo') as { generation: number; quarantined: number };
      assert(row.generation === 1, `expected generation 1, got ${row.generation}`);
      assert(row.quarantined === 0, `expected quarantined 0, got ${row.quarantined}`);

      db.query(
        'UPDATE run_locks SET generation = generation + 1, quarantined = 1 WHERE working_tree_key = ?',
      ).run('/tmp/demo');
      const updated = db
        .query('SELECT generation, quarantined FROM run_locks WHERE working_tree_key = ?')
        .get('/tmp/demo') as { generation: number; quarantined: number };
      assert(
        updated.generation === 2,
        `expected generation 2 after bump, got ${updated.generation}`,
      );
      assert(
        updated.quarantined === 1,
        `expected quarantined 1 after quarantine, got ${updated.quarantined}`,
      );
    });

    closeDatabase(db);

    // --- 6. Database reopen ---------------------------------------------------
    check('reopen: tables, schema, records and WAL mode survive close/reopen', () => {
      const reopened = openDatabase({ path: dbPath });
      try {
        assert(
          reopened.query("SELECT 1 FROM tasks WHERE id = 'task-1'").get() !== null,
          'expected task-1 to persist',
        );
        assert(
          reopened.query("SELECT 1 FROM messages WHERE id = 'msg-1'").get() !== null,
          'expected msg-1 to persist',
        );
        assert(
          pragma(reopened, 'journal_mode').toLowerCase() === 'wal',
          'expected WAL mode after reopen',
        );
        const tables = reopened
          .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((r) => (r as { name: string }).name);
        assert(tables.includes('run_locks'), 'expected run_locks table after reopen');
      } finally {
        closeDatabase(reopened);
      }
    });

    // --- 7. Incompatible schema rejection -------------------------------------
    check('incompatible schema: version higher than known throws IncompatibleSchemaError', () => {
      const probe = openDatabase({ path: dbPath });
      try {
        probe
          .query(
            'INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
          )
          .run(999, 'future_migration', now, 'deadbeef');
        assertThrows(
          () => runMigrations(probe),
          IncompatibleSchemaError,
          'expected future version rejection',
        );
      } finally {
        probe.query('DELETE FROM _migrations WHERE version = 999').run();
        closeDatabase(probe);
      }
    });

    check('incompatible schema: tampered checksum throws IncompatibleSchemaError', () => {
      const probe = openDatabase({ path: dbPath });
      try {
        probe
          .query('UPDATE _migrations SET checksum = ? WHERE version = 1')
          .run('tampered-checksum');
        assertThrows(
          () => runMigrations(probe),
          IncompatibleSchemaError,
          'expected checksum mismatch rejection',
        );
      } finally {
        closeDatabase(probe);
      }
    });

    // --- 8. Process boundary: no bun:sqlite imports outside src/backend ------
    check('boundary: no bun:sqlite imports outside src/backend', () => {
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
          if (
            fullPath === import.meta.path ||
            fullPath === join(repoRoot, 'src', 'harness', 'harness-checks.ts')
          ) {
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
      assert(
        nonBackendOffenders.length === 0,
        `expected zero bun:sqlite imports outside src/backend, found: ${nonBackendOffenders.join(', ')}`,
      );
    });
  } finally {
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

main();
