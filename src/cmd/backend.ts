// Backend entrypoint shell (ARCHITECTURE.md §2.1): owns SQLite, task/chat domains,
// public REST, MCP and browser SSE. Run lifecycle internal endpoints (claim,
// heartbeat, finalize, ...) land in T12; event/input commits land in T13.
import { mountInternalApi, mountPublicApi } from '../backend/api/index.ts';
import { initializeDatabase } from '../backend/index.ts';
import { createServiceApp, mountInternal } from '../supervisor/service-app.ts';

const db = initializeDatabase();

const port = Number(process.env.TASKASIDE_BACKEND_PORT ?? 0);
const app = createServiceApp('backend', port);
mountInternal(app, ['supervisor', 'engine']);
mountInternalApi(app, db);
mountPublicApi(app, db);

export default {
  port,
  hostname: '127.0.0.1',
  fetch: app.fetch,
  idleTimeout: 0,
};
