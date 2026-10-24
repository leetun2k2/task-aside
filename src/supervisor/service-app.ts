// Shared Hono app scaffold for the three service CMDs: loopback Host/Origin
// hardening plus the versioned health endpoint (ARCHITECTURE.md §3.1, §8.1;
// SPECIFICATION.md §3, §8). Internal route auth is opt-in via `mountInternal`,
// since only backend and agent-adapter expose `/internal/v1/*`.
import { Hono } from 'hono';
import { type ServiceRole, internalAuth } from './auth.ts';
import { hostOriginGuard } from './host-origin.ts';
import { TASKASIDE_VERSION } from './version.ts';

export function createServiceApp(serviceName: string, port: number): Hono {
  const startedAt = Date.now();
  const app = new Hono();

  app.use('*', hostOriginGuard(port));

  app.get('/health', (c) =>
    c.json({
      status: 'ok' as const,
      service: serviceName,
      version: TASKASIDE_VERSION,
      uptime: (Date.now() - startedAt) / 1000,
    }),
  );

  return app;
}

// Mounts the internal-route auth guard and a connectivity stub at
// `/internal/v1/ping`. Real `/internal/v1/*` endpoints (claim, heartbeat,
// events, ...) land in T10-T19; this proves the auth boundary for T08.
export function mountInternal(app: Hono, allowedRoles: ServiceRole[]): void {
  app.use('/internal/v1/*', internalAuth(allowedRoles));
  app.get('/internal/v1/ping', (c) => c.json({ ok: true }));
}
