// Settings repository (SPECIFICATION.md §3, TASKS.md T15, LC-02a).
import type { Database } from 'bun:sqlite';

export interface SettingsRow {
  id: number;
  default_provider: string;
  max_concurrency: number;
  root_workspace: string | null;
  active_harnesses?: string | null;
  updated_at: string;
}

export function getSettingsRow(db: Database): SettingsRow | null {
  return db
    .query(
      'SELECT id, default_provider, max_concurrency, root_workspace, active_harnesses, updated_at FROM settings WHERE id = 1',
    )
    .get() as SettingsRow | null;
}

export function updateSettingsRow(
  db: Database,
  defaultProvider: string,
  maxConcurrency: number,
  updatedAt: string,
  rootWorkspace: string | null = null,
  activeHarnesses = '["claude","codex","agy"]',
): void {
  db.query(
    'UPDATE settings SET default_provider = ?, max_concurrency = ?, root_workspace = ?, active_harnesses = ?, updated_at = ? WHERE id = 1',
  ).run(defaultProvider, maxConcurrency, rootWorkspace, activeHarnesses, updatedAt);
}

export function countTasks(db: Database): number {
  const row = db.query('SELECT COUNT(*) as count FROM tasks').get() as { count: number } | null;
  return row?.count ?? 0;
}

export function countRuns(db: Database): number {
  const row = db.query('SELECT COUNT(*) as count FROM runs').get() as { count: number } | null;
  return row?.count ?? 0;
}

export function countActiveRuns(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM runs WHERE status IN ('running', 'hitl')")
    .get() as { count: number } | null;
  return row?.count ?? 0;
}

export function getDatabasePath(db: Database): string {
  const row = db.query('PRAGMA database_list').get() as { file?: string } | null;
  return row?.file ?? ':memory:';
}
