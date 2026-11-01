// OS-appropriate app-data paths (ARCHITECTURE.md §8/§10, SPECIFICATION.md §8).
// `TASKASIDE_DATA_DIR` always wins, so tests and multiple local instances can run
// against disposable directories.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getDataDir(): string {
  const override = process.env.TASKASIDE_DATA_DIR;
  if (override) {
    return override;
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'TaskAside');
  }

  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'TaskAside');
  }

  const xdgDataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdgDataHome, 'taskaside');
}

export function getLogsDir(): string {
  return join(getDataDir(), 'logs');
}

export function ensureDataDirs(): void {
  mkdirSync(getDataDir(), { recursive: true });
  mkdirSync(getLogsDir(), { recursive: true });
}

export function getLaunchJournalPath(): string {
  return join(getDataDir(), 'agent-adapter', 'launch-journal.json');
}

export function getLockFilePath(): string {
  return join(getDataDir(), 'supervisor.json');
}

export function getAuthTokenPath(): string {
  return join(getDataDir(), 'auth.token');
}

export function getInternalTokenPath(): string {
  return join(getDataDir(), 'internal.token');
}

export function getLogFilePath(serviceName: string): string {
  return join(getLogsDir(), `${serviceName}.log`);
}

/**
 * App-owned scratch directory for an Intake attempt (specs/2026-10-25-
 * message-intake/01-contracts-and-lifecycle.md "Its cwd is an app-owned
 * scratch directory"; 00-overview.md "Document a narrow constitution
 * exception for non-writing Intake in an app-owned scratch directory").
 * Intake never edits a registered repository, so this directory is never a
 * registered working tree and is created fresh per task so concurrent
 * Intake attempts cannot see each other's scratch files.
 */
export function getIntakeScratchDir(taskId: string): string {
  return join(getDataDir(), 'intake-scratch', taskId);
}

export function getDatabasePath(): string {
  const override = process.env.TASKASIDE_DB_PATH;
  if (override) {
    return override;
  }
  return join(getDataDir(), 'taskaside.db');
}
