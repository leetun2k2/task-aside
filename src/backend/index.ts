// Backend database lifecycle entry point (T10). Only `src/backend` may import
// `bun:sqlite` (AGENTS.md §3); other processes must go through internal/public
// REST, not this module.
import type { Database } from 'bun:sqlite';
import { type OpenDatabaseOptions, closeDatabase, openDatabase } from './db/connection.ts';
import { runMigrations } from './db/migrations.ts';

export { closeDatabase, openDatabase, type OpenDatabaseOptions } from './db/connection.ts';
export { IncompatibleSchemaError, runMigrations } from './db/migrations.ts';
export {
  claimTask,
  clearQuarantine,
  finalizeRun,
  getRunStatus,
  getTaskContext,
  heartbeat,
  listRunnableTasks,
  markUncertain,
  type RunStatusRecord,
  type TaskContext,
} from './domains/task/runs.ts';
export {
  createRepository,
  listRepositories,
  getRepositoryById,
} from './domains/task/repositories.ts';
export {
  createTask,
  getTaskById,
  listTasks,
  updateTask,
  cancelTask,
  retryTask,
  type TaskRecord,
} from './domains/task/tasks.ts';
export { ingestEvents } from './domains/task/events.ts';
export {
  mintManagedMcpToken,
  createPairingCode,
  approvePairing,
  revokeMcpToken,
  listExternalMcpTokens,
  validateMcpToken,
  type McpAuthContext,
  type ManagedMcpAuthContext,
  type ExternalMcpAuthContext,
} from './mcp/tokens.ts';
export { executeMcpTool } from './mcp/tools.ts';
export { mountMcpRoutes } from './mcp/handler.ts';
export { getSettings, updateSettings, getDiagnostics } from './domains/settings/settings.ts';
export { eventHub, EventHub, type BrowserEvent, type HubEvent } from './events/hub.ts';
export { mountPublicApi, type MountPublicApiOptions } from './api/index.ts';

export function initializeDatabase(options: OpenDatabaseOptions = {}): Database {
  const db = openDatabase(options);
  try {
    runMigrations(db);
  } catch (err) {
    closeDatabase(db);
    throw err;
  }
  return db;
}
