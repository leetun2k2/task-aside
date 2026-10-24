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
import { requestRunCancellationForTask } from '../domains/task/runs.ts';
import {
  cancelTask,
  createTask,
  getTaskById,
  listTasks,
  retryTask,
  updateTask,
} from '../domains/task/tasks.ts';
import { DomainError } from './errors.ts';

export function mountTaskRoutes(app: Hono, db: Database): void {
  app.post('/api/tasks', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid task input', parsed.error.flatten());
    }
    return c.json(createTask(db, parsed.data), 201);
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
      listTasks(db, {
        status: status?.data,
        priority: priority?.data,
        repositoryId: c.req.query('repositoryId') ?? undefined,
        query: c.req.query('query') ?? undefined,
      }),
    );
  });

  app.get('/api/tasks/:id', (c) => {
    const task = getTaskById(db, c.req.param('id'));
    if (!task) {
      throw new DomainError('NOT_FOUND', `task not found: ${c.req.param('id')}`);
    }
    return c.json(task);
  });

  app.patch('/api/tasks/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid task update', parsed.error.flatten());
    }
    return c.json(updateTask(db, c.req.param('id'), parsed.data));
  });

  app.post('/api/tasks/:id/cancel', (c) => {
    const id = c.req.param('id');
    const task = getTaskById(db, id);
    if (!task) {
      throw new DomainError('NOT_FOUND', `task not found: ${id}`);
    }
    if (task.status === 'processing' || task.status === 'hitl') {
      return c.json(requestRunCancellationForTask(db, id));
    }
    return c.json(cancelTask(db, id));
  });

  app.post('/api/tasks/:id/retry', (c) => c.json(retryTask(db, c.req.param('id'))));
}
