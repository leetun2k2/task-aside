// Settings REST API routes (SPECIFICATION.md §3, §8.1; TASKS.md T15, LC-02a).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { UpdateSettingsInputSchema } from '../../contracts/settings.ts';
import { browserAuth } from '../../supervisor/auth.ts';
import { getDiagnosticsUsecase } from '../domains/settings/usecases/get-diagnostics-usecase.ts';
import { getSettingsUsecase } from '../domains/settings/usecases/get-settings-usecase.ts';
import { updateSettingsUsecase } from '../domains/settings/usecases/update-settings-usecase.ts';
import { eventHub } from '../events/hub.ts';
import { DomainError } from './errors.ts';

export function mountSettingsRoutes(
  app: Hono,
  db: Database,
  options: { token?: string } = {},
): void {
  // Settings endpoints are browser-authenticated
  app.use('/api/settings', browserAuth({ token: options.token }));

  app.get('/api/settings', (c) => {
    const settings = getSettingsUsecase(db);
    const diagnostics = getDiagnosticsUsecase(db, {
      connectedClients: eventHub.getSubscriberCount(),
    });
    return c.json({
      ...settings,
      diagnostics,
    });
  });

  app.patch('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid settings input', parsed.error.flatten());
    }

    const updated = updateSettingsUsecase(db, parsed.data);
    const diagnostics = getDiagnosticsUsecase(db, {
      connectedClients: eventHub.getSubscriberCount(),
    });

    return c.json({
      ...updated,
      diagnostics,
    });
  });
}
