// SQLite connection manager (AGENTS.md §3: only backend may open SQLite).
// Enforces WAL mode, foreign keys and busy/synchronous pragmas on every open.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDatabasePath } from '../../supervisor/paths.ts';

export interface OpenDatabaseOptions {
  /** Absolute file path, or ':memory:'. Defaults to getDatabasePath(). */
  path?: string;
}

export function openDatabase(options: OpenDatabaseOptions = {}): Database {
  const path = options.path ?? getDatabasePath();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

export function closeDatabase(db: Database): void {
  db.close();
}
