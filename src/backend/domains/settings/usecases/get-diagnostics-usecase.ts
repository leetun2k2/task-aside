// Get diagnostics usecase (SPECIFICATION.md §3, TASKS.md T15, LC-02a).
import type { Database } from 'bun:sqlite';
import type { Diagnostics } from '../../../../contracts/index.ts';
import {
  countActiveRuns,
  countRuns,
  countTasks,
  getDatabasePath,
} from '../repositories/settings-repository.ts';

const processStartTime = Date.now();

// Simple read bypasses empty service layer: usecase -> repository
export function getDiagnosticsUsecase(
  db: Database,
  options: { connectedClients?: number } = {},
): Diagnostics {
  const uptimeSeconds = Math.floor((Date.now() - processStartTime) / 1000);

  return {
    service: 'backend',
    version: '0.1.0',
    uptimeSeconds,
    tasksCount: countTasks(db),
    runsCount: countRuns(db),
    activeRunsCount: countActiveRuns(db),
    connectedClients: options.connectedClients ?? 0,
    dbPath: getDatabasePath(db),
  };
}
