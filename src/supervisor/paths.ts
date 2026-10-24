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

export function getDatabasePath(): string {
  const override = process.env.TASKASIDE_DB_PATH;
  if (override) {
    return override;
  }
  return join(getDataDir(), 'taskaside.db');
}
