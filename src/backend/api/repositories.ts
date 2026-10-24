// Public REST routes for repository registration (SPECIFICATION.md §3).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { CreateRepositoryInputSchema } from '../../contracts/task.ts';
import { createRepository, listRepositories } from '../domains/task/repositories.ts';
import { DomainError } from './errors.ts';

export function mountRepositoryRoutes(app: Hono, db: Database): void {
  app.post('/api/repositories', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateRepositoryInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid repository input', parsed.error.flatten());
    }
    return c.json(createRepository(db, parsed.data), 201);
  });

  app.get('/api/repositories', (c) => c.json(listRepositories(db)));
}
