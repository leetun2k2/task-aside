// Migration runner (SPECIFICATION.md §6, T10 acceptance criteria).
// Tracks applied migrations in `_migrations` and rejects a database file that
// is newer than this build or whose recorded checksum has been tampered with.
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { CHAT_CONVERSATIONS_SCHEMA, CHAT_MESSAGES_SCHEMA } from '../domains/chat/schema.ts';
import {
  HARNESS_SETTINGS_SCHEMA,
  ROOT_WORKSPACE_SCHEMA,
  SETTINGS_DOMAIN_SCHEMA,
} from '../domains/settings/schema.ts';
import {
  HANDOFF_SINGLE_WRITER_SCHEMA,
  INTAKE_RUNTIME_COMPLETION_SCHEMA,
  MESSAGE_INTAKE_SCHEMA,
  POLLING_WORKER_POOL_SCHEMA,
  TASK_DOMAIN_SCHEMA,
} from '../domains/task/schema.ts';
import { MCP_DOMAIN_SCHEMA } from '../mcp/schema.ts';

export class IncompatibleSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleSchemaError';
  }
}

interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

function checksumOf(statements: readonly string[]): string {
  return createHash('sha256').update(statements.join('\n')).digest('hex');
}

// Conversations must exist before `tasks` (FK to conversations) and before
// `messages` (FK to conversations); see domains/chat/schema.ts for why the
// chat domain schema is split across the task domain's tables.
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    statements: [...CHAT_CONVERSATIONS_SCHEMA, ...TASK_DOMAIN_SCHEMA, ...CHAT_MESSAGES_SCHEMA],
  },
  {
    version: 2,
    name: '002_mcp_schema',
    statements: MCP_DOMAIN_SCHEMA,
  },
  {
    version: 3,
    name: '003_settings_and_versions',
    statements: SETTINGS_DOMAIN_SCHEMA,
  },
  {
    version: 4,
    name: '004_handoff_single_writer',
    statements: HANDOFF_SINGLE_WRITER_SCHEMA,
  },
  {
    version: 5,
    name: '005_polling_worker_pool',
    statements: POLLING_WORKER_POOL_SCHEMA,
  },
  {
    version: 6,
    name: '006_root_workspace_setting',
    statements: ROOT_WORKSPACE_SCHEMA,
  },
  {
    version: 7,
    name: '007_harness_settings',
    statements: HARNESS_SETTINGS_SCHEMA,
  },
  {
    version: 8,
    name: '008_message_intake',
    statements: MESSAGE_INTAKE_SCHEMA,
  },
  {
    version: 9,
    name: '009_intake_runtime_completion',
    statements: INTAKE_RUNTIME_COMPLETION_SCHEMA,
  },
];

function ensureMigrationsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  )`);
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

function getAppliedMigrations(db: Database): AppliedMigrationRow[] {
  return db
    .query('SELECT version, name, checksum FROM _migrations ORDER BY version')
    .all() as AppliedMigrationRow[];
}

function assertCompatible(applied: AppliedMigrationRow[]): void {
  const latestKnownVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const byVersion = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));

  for (const row of applied) {
    if (row.version > latestKnownVersion) {
      throw new IncompatibleSchemaError(
        `database has applied migration version ${row.version}, which is newer than the ` +
          `highest version ${latestKnownVersion} supported by this build`,
      );
    }

    const known = byVersion.get(row.version);
    if (!known) {
      throw new IncompatibleSchemaError(
        `database references unknown migration version ${row.version}`,
      );
    }

    const expectedChecksum = checksumOf(known.statements);
    if (row.checksum !== expectedChecksum) {
      throw new IncompatibleSchemaError(
        `checksum mismatch for migration ${row.version} (${row.name}): database recorded ` +
          `${row.checksum}, expected ${expectedChecksum}`,
      );
    }
  }
}

export function runMigrations(db: Database): void {
  ensureMigrationsTable(db);
  const applied = getAppliedMigrations(db);
  assertCompatible(applied);

  const appliedVersions = new Set(applied.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const apply = db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.query(
        'INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(
        migration.version,
        migration.name,
        new Date().toISOString(),
        checksumOf(migration.statements),
      );
    });
    apply();
  }

  backfillLegacyInitialMessages(db);
}

interface LegacyTaskRow {
  id: string;
  conversation_id: string;
  title: string;
  description: string | null;
  created_at: string;
}

/**
 * One-time, idempotent data backfill for pre-Intake tasks (01-contracts-and-
 * lifecycle.md "Migration and compatibility"): every task needs exactly one
 * initial chat message and an authorized/resolved repo scope recorded in the
 * new JSON columns, or it can never satisfy the Message-first contract nor
 * participate in shared-conversation message attribution.
 *
 * Runs on every startup (cheap: the WHERE clause only matches rows the SQL
 * migration above could not populate — new UUIDs and derived chat content
 * require JS, not plain SQL) but only mutates rows that have not been
 * migrated yet, so it can never insert a duplicate initial message or
 * reroute an active/terminal legacy task (both are left exactly as they are
 * — this only fills in metadata, never changes `status`).
 */
function backfillLegacyInitialMessages(db: Database): void {
  const pending = db
    .query(
      `SELECT id, conversation_id, title, description, created_at
       FROM tasks WHERE initial_message_id IS NULL`,
    )
    .all() as LegacyTaskRow[];

  if (pending.length === 0) {
    return;
  }

  const apply = db.transaction(() => {
    for (const task of pending) {
      const content = task.description?.trim() ? task.description : task.title;
      const messageId = `msg_legacy_${task.id}`;

      // Idempotent: a prior partial run (crash between insert and the tasks
      // UPDATE below) may have already inserted this exact message id.
      const existing = db.query('SELECT id FROM messages WHERE id = ?').get(messageId) as {
        id: string;
      } | null;
      if (!existing) {
        db.query(
          `INSERT INTO messages
            (id, conversation_id, role, content, in_reply_to_request_id, source_run_id,
             source_event_seq, created_at, origin_task_id)
           VALUES (?, ?, 'user', ?, NULL, NULL, NULL, ?, ?)`,
        ).run(messageId, task.conversation_id, content, task.created_at, task.id);
      }

      db.query('UPDATE tasks SET initial_message_id = ? WHERE id = ?').run(messageId, task.id);
      db.query(
        `UPDATE messages SET origin_task_id = ?
         WHERE conversation_id = ? AND origin_task_id IS NULL`,
      ).run(task.id, task.conversation_id);
    }
  });
  apply();
}
