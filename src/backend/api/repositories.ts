// Public REST routes for repository registration (SPECIFICATION.md §3, LC-02b).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { CreateRepositoryInputSchema } from '../../contracts/task.ts';
import { deleteRepositoryUsecase } from '../domains/task/usecases/delete-repository-usecase.ts';
import { listRepositoriesUsecase } from '../domains/task/usecases/list-repositories-usecase.ts';
import { registerRepositoryUsecase } from '../domains/task/usecases/register-repository-usecase.ts';
import { DomainError } from './errors.ts';

export function mountRepositoryRoutes(app: Hono, db: Database): void {
  app.post('/api/repositories', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateRepositoryInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid repository input', parsed.error.flatten());
    }
    return c.json(registerRepositoryUsecase(db, parsed.data), 201);
  });

  app.get('/api/repositories', (c) => c.json(listRepositoriesUsecase(db)));

  app.delete('/api/repositories/:id', (c) => {
    deleteRepositoryUsecase(db, c.req.param('id'));
    return c.body(null, 204);
  });
}
