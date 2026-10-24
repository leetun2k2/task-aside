// Mounts the public REST API (repositories, tasks, chat, settings, events, static)
// and the shared domain error handler onto a service app (ARCHITECTURE.md §2.1).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { browserAuth } from '../../supervisor/auth.ts';
import { mountMcpRoutes } from '../mcp/handler.ts';
import { mountChatRoutes } from './chat.ts';
import { registerErrorHandler } from './errors.ts';
import { mountEventsRoutes } from './events.ts';
import { mountRepositoryRoutes } from './repositories.ts';
import { mountInternalRunRoutes } from './runs.ts';
import { mountSettingsRoutes } from './settings.ts';
import { mountStaticRoutes } from './static.ts';
import { mountTaskRoutes } from './tasks.ts';

export interface MountPublicApiOptions {
  requireAuth?: boolean;
  authToken?: string;
  staticDir?: string;
}

export function mountPublicApi(app: Hono, db: Database, options: MountPublicApiOptions = {}): void {
  registerErrorHandler(app);

  if (options.requireAuth) {
    app.use('/api/repositories', browserAuth({ token: options.authToken }));
    app.use('/api/repositories/*', browserAuth({ token: options.authToken }));
    app.use('/api/tasks', browserAuth({ token: options.authToken }));
    app.use('/api/tasks/*', browserAuth({ token: options.authToken }));
    app.use('/api/conversations/*', browserAuth({ token: options.authToken }));
  }

  mountRepositoryRoutes(app, db);
  mountTaskRoutes(app, db);
  mountChatRoutes(app, db);
  mountMcpRoutes(app, db);
  mountSettingsRoutes(app, db, { token: options.authToken });
  mountEventsRoutes(app, { token: options.authToken });
  mountStaticRoutes(app, { staticDir: options.staticDir });
}

// Mounts `/internal/v1/*` run lifecycle routes. Callers must mount
// `internalAuth` (see supervisor/service-app.ts `mountInternal`) first.
export function mountInternalApi(app: Hono, db: Database): void {
  mountInternalRunRoutes(app, db);
}
