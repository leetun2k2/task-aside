// Settings repository (SPECIFICATION.md §3, TASKS.md T15).
import type { Database } from 'bun:sqlite';
import type {
  Diagnostics,
  Provider,
  Settings,
  UpdateSettingsInput,
} from '../../../contracts/index.ts';
import { DomainError } from '../../api/errors.ts';

interface SettingsRow {
  id: number;
  default_provider: string;
  max_concurrency: number;
  updated_at: string;
}

const startTime = Date.now();

export function getSettings(db: Database): Settings {
  const row = db
    .query('SELECT id, default_provider, max_concurrency, updated_at FROM settings WHERE id = 1')
    .get() as SettingsRow | null;

  if (!row) {
    throw new DomainError('NOT_FOUND', 'settings record missing');
  }

  return {
    defaultProvider: row.default_provider as Provider,
    maxConcurrency: row.max_concurrency,
    updatedAt: row.updated_at,
  };
}

export function updateSettings(db: Database, input: UpdateSettingsInput): Settings {
  const current = getSettings(db);
  const defaultProvider = input.defaultProvider ?? current.defaultProvider;
  const maxConcurrency = input.maxConcurrency ?? current.maxConcurrency;
  const updatedAt = new Date().toISOString();

  db.query(
    'UPDATE settings SET default_provider = ?, max_concurrency = ?, updated_at = ? WHERE id = 1',
  ).run(defaultProvider, maxConcurrency, updatedAt);

  return {
    defaultProvider,
    maxConcurrency,
    updatedAt,
  };
}

export function getDiagnostics(
  db: Database,
  options: { connectedClients?: number } = {},
): Diagnostics {
  const tasksCountRow = db.query('SELECT COUNT(*) as count FROM tasks').get() as {
    count: number;
  } | null;
  const runsCountRow = db.query('SELECT COUNT(*) as count FROM runs').get() as {
    count: number;
  } | null;
  const activeRunsCountRow = db
    .query("SELECT COUNT(*) as count FROM runs WHERE status IN ('running', 'hitl')")
    .get() as { count: number } | null;

  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Get db filename from pragma
  const dbFileRow = db.query('PRAGMA database_list').get() as { file?: string } | null;

  return {
    service: 'backend',
    version: '0.1.0',
    uptimeSeconds,
    tasksCount: tasksCountRow?.count ?? 0,
    runsCount: runsCountRow?.count ?? 0,
    activeRunsCount: activeRunsCountRow?.count ?? 0,
    connectedClients: options.connectedClients ?? 0,
    dbPath: dbFileRow?.file ?? ':memory:',
  };
}
