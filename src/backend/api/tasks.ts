// Public REST routes for task CRUD/filtering/transitions (SPECIFICATION.md §2
// T-01, §5).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import {
  CreateTaskInputSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
  UpdateTaskInputSchema,
} from '../../contracts/task.ts';
import { cancelTaskUsecase } from '../domains/task/usecases/cancel-task-usecase.ts';
import { createTaskUsecase } from '../domains/task/usecases/create-task-usecase.ts';
import { getTaskUsecase } from '../domains/task/usecases/get-task-usecase.ts';
import { listTasksUsecase } from '../domains/task/usecases/list-tasks-usecase.ts';
import { retryTaskUsecase } from '../domains/task/usecases/retry-task-usecase.ts';
import { updateTaskUsecase } from '../domains/task/usecases/update-task-usecase.ts';
import { DomainError } from './errors.ts';

/**
 * Bounded, one-release legacy input adapter (specs/2026-10-25-message-
 * intake/01-contracts-and-lifecycle.md "Migration and compatibility":
 * "During one release, legacy requests lacking Message map nonblank
 * Description, or Title if Description is absent, into Message. When both
 * Message and Description are present, reject conflicting bodies; matching
 * bodies map once."). Deliberately narrow: it only ever touches a request
 * that has no `message` field at all — never second-guesses a caller that
 * already sends the new shape.
 */
function legacyCreateTaskAdapter(body: unknown): unknown {
  if (!body || typeof body !== 'object' || 'message' in body) {
    return body;
  }
  const record = body as { description?: unknown; title?: unknown };
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const message = description || title;
  if (!message) {
    return body;
  }
  return { ...record, message };
}

export function mountTaskRoutes(app: Hono, db: Database): void {
  app.post('/api/tasks', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTaskInputSchema.safeParse(legacyCreateTaskAdapter(body));
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid task input', parsed.error.flatten());
    }
    return c.json(createTaskUsecase(db, parsed.data), 201);
  });

  app.get('/api/tasks', (c) => {
    const statusParam = c.req.query('status');
    const priorityParam = c.req.query('priority');

    const status = statusParam ? TaskStatusSchema.safeParse(statusParam) : undefined;
    if (status && !status.success) {
      throw new DomainError('VALIDATION_ERROR', `invalid status filter: ${statusParam}`);
    }
    const priority = priorityParam ? TaskPrioritySchema.safeParse(priorityParam) : undefined;
    if (priority && !priority.success) {
      throw new DomainError('VALIDATION_ERROR', `invalid priority filter: ${priorityParam}`);
    }

    return c.json(
      listTasksUsecase(db, {
        status: status?.data,
        priority: priority?.data,
        repositoryId: c.req.query('repositoryId') ?? undefined,
        query: c.req.query('query') ?? undefined,
      }),
    );
  });

  app.get('/api/tasks/:id', (c) => {
    const task = getTaskUsecase(db, c.req.param('id'));
    if (!task) {
      throw new DomainError('NOT_FOUND', `task not found: ${c.req.param('id')}`);
    }
    return c.json(task);
  });

  app.patch('/api/tasks/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const normalized =
      body && typeof body === 'object' && !('message' in body) && 'description' in body
        ? { ...(body as Record<string, unknown>), message: (body as { description?: unknown }).description }
        : body;
    const parsed = UpdateTaskInputSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid task update', parsed.error.flatten());
    }
    return c.json(updateTaskUsecase(db, c.req.param('id'), parsed.data));
  });

  app.post('/api/tasks/:id/cancel', (c) => c.json(cancelTaskUsecase(db, c.req.param('id'))));

  app.post('/api/tasks/:id/retry', (c) => c.json(retryTaskUsecase(db, c.req.param('id'))));
}
