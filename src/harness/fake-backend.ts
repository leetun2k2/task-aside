// Fake backend for the deterministic run harness (T09, ARCHITECTURE.md §3 /
// CONSTITUTION.md §III): reproduces claim/heartbeat/events/finalize/
// mark-uncertain/clear-quarantine and atomic HITL reply pairing in memory.
// This is test-only code; only the real backend may own SQLite (AGENTS.md §3).
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ClaimTaskRequestSchema,
  ClaimTaskResponseSchema,
  ClearQuarantineRequestSchema,
  FinalizeRunRequestSchema,
  HeartbeatRequestSchema,
  IngestEventsRequestSchema,
  MarkUncertainRequestSchema,
  type Task,
  type TaskPriority,
  type TaskStatus,
  computeEventHash,
} from '../contracts/index.ts';
import { internalAuth } from '../supervisor/auth.ts';
import { hostOriginGuard } from '../supervisor/host-origin.ts';

const ClaimRequestSchema = ClaimTaskRequestSchema.extend({
  taskId: z.string().min(1),
  repoPath: z.string().min(1),
});

const PostTaskMessageSchema = z.object({
  content: z.string().min(1),
  inReplyToRequestId: z.string().optional(),
});

type LockStatus = 'held' | 'quarantined' | 'released';

interface LockRecord {
  status: LockStatus;
  ownerId: string;
  generation: number;
}

type RunStatus = 'running' | 'hitl' | 'done' | 'error' | 'cancelled' | 'uncertain';

interface RunRecord {
  runId: string;
  taskId: string;
  ownerId: string;
  generation: number;
  repoPath: string;
  status: RunStatus;
  pendingRequestId: string | null;
  verifiedStopped: boolean;
}

interface TaskRecord {
  status: TaskStatus;
  priority: TaskPriority;
  blockedOnChildIds: string[] | null;
  activeRunId: string | null;
}

export interface FakeBackendState {
  runs: Map<string, RunRecord>;
  events: Map<string, Map<number, { hash: string }>>;
  locks: Map<string, LockRecord>;
  tasks: Map<string, TaskRecord>;
  lostAckArmed: Set<string>;
}

export function createFakeBackendState(): FakeBackendState {
  return {
    runs: new Map(),
    events: new Map(),
    locks: new Map(),
    tasks: new Map(),
    lostAckArmed: new Set(),
  };
}

function taskSnapshotFor(taskId: string, task: TaskRecord, runId: string | null): Task {
  const now = new Date().toISOString();
  return {
    id: taskId,
    title: `Harness task ${taskId}`,
    repoId: 'harness-repo',
    status: task.status,
    priority: task.priority,
    parentId: null,
    depth: 0,
    createdAt: now,
    updatedAt: now,
    blockedReason: null,
    blockedOnChildIds: task.blockedOnChildIds,
    activeRunId: runId,
    version: 0,
  };
}

// Standalone Hono app bound to 127.0.0.1 by the caller. Mirrors
// SPECIFICATION.md §3's backend internal endpoints against in-memory state.
export function createFakeBackend(
  port: number,
  state: FakeBackendState = createFakeBackendState(),
): Hono {
  const app = new Hono();
  app.use('*', hostOriginGuard(port));
  app.use('/internal/v1/*', internalAuth(['engine', 'adapter', 'supervisor']));

  app.get('/health', (c) => c.json({ status: 'ok', service: 'fake-backend' }));

  app.post('/internal/v1/runs/claim', async (c) => {
    const parsed = ClaimRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    const body = parsed.data;

    const existingLock = state.locks.get(body.repoPath);
    if (existingLock && existingLock.status !== 'released') {
      return c.json(
        { code: 'LOCK_HELD', message: `working tree ${body.repoPath} is ${existingLock.status}` },
        409,
      );
    }

    const generation = (existingLock?.generation ?? 0) + 1;
    const runId = `run_${crypto.randomUUID()}`;

    state.locks.set(body.repoPath, { status: 'held', ownerId: body.ownerId, generation });
    state.runs.set(runId, {
      runId,
      taskId: body.taskId,
      ownerId: body.ownerId,
      generation,
      repoPath: body.repoPath,
      status: 'running',
      pendingRequestId: null,
      verifiedStopped: false,
    });

    const task = state.tasks.get(body.taskId) ?? {
      status: 'todo' as TaskStatus,
      priority: 'P2' as TaskPriority,
      blockedOnChildIds: null,
      activeRunId: null,
    };
    task.status = 'processing';
    task.activeRunId = runId;
    state.tasks.set(body.taskId, task);

    const response = ClaimTaskResponseSchema.parse({
      runId,
      generation,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      taskSnapshot: taskSnapshotFor(body.taskId, task, runId),
      deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
      workingTreeKey: body.repoPath,
    });
    return c.json(response);
  });

  app.post('/internal/v1/runs/:id/heartbeat', async (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    const parsed = HeartbeatRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    if (run.ownerId !== parsed.data.ownerId || run.generation !== parsed.data.generation) {
      return c.json({ code: 'STALE_GENERATION', message: 'ownerId/generation mismatch' }, 409);
    }

    return c.json({ ok: true });
  });

  app.post('/internal/v1/runs/:id/events', async (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    const parsed = IngestEventsRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    const body = parsed.data;
    if (run.ownerId !== body.ownerId || run.generation !== body.generation) {
      return c.json({ code: 'STALE_GENERATION', message: 'ownerId/generation mismatch' }, 409);
    }

    let receipts = state.events.get(runId);
    if (!receipts) {
      receipts = new Map();
      state.events.set(runId, receipts);
    }

    for (const event of body.events) {
      const hash = computeEventHash(event);
      const existing = receipts.get(event.sequence);

      if (existing) {
        if (existing.hash !== hash) {
          return c.json(
            {
              code: 'SEQUENCE_CONFLICT',
              message: `sequence ${event.sequence} already recorded with a different payload`,
            },
            409,
          );
        }
        continue; // Identical retry: idempotent, no repeated side effect.
      }

      receipts.set(event.sequence, { hash });

      if (event.type === 'input_required') {
        run.pendingRequestId = event.data.requestId;
        const task = state.tasks.get(run.taskId);
        if (task) {
          task.status = 'hitl';
        }
        run.status = 'hitl';
      }
    }

    // Simulates a dropped ACK: the event is already committed above, but the
    // caller never sees this response and must retry the identical tuple.
    const simulateLostAck = c.req.header('x-simulate-lost-ack') === 'true';
    if (simulateLostAck && !state.lostAckArmed.has(runId)) {
      state.lostAckArmed.add(runId);
      return c.body('simulated dropped ack', 503);
    }

    return c.json({ ok: true });
  });

  app.post('/internal/v1/runs/:id/finalize', async (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    const parsed = FinalizeRunRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ code: 'VERIFIED_STOP_REQUIRED', message: parsed.error.message }, 400);
    }
    const body = parsed.data;
    if (run.ownerId !== body.ownerId || run.generation !== body.generation) {
      return c.json({ code: 'STALE_GENERATION', message: 'ownerId/generation mismatch' }, 409);
    }

    run.status = body.status;
    run.verifiedStopped = body.verifiedStopped;

    const task = state.tasks.get(run.taskId);
    if (task) {
      task.status = body.status;
      task.activeRunId = null;
    }

    const lock = state.locks.get(run.repoPath);
    if (lock && lock.status === 'held') {
      lock.status = 'released';
    }

    return c.json({ ok: true });
  });

  app.post('/internal/v1/runs/:id/mark-uncertain', async (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    const parsed = MarkUncertainRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    if (run.ownerId !== parsed.data.ownerId || run.generation !== parsed.data.generation) {
      return c.json({ code: 'STALE_GENERATION', message: 'ownerId/generation mismatch' }, 409);
    }

    run.status = 'uncertain';
    const lock = state.locks.get(run.repoPath);
    if (lock) {
      lock.status = 'quarantined';
    }

    return c.json({ ok: true });
  });

  app.post('/internal/v1/runs/:id/clear-quarantine', async (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    const parsed = ClearQuarantineRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }

    const lock = state.locks.get(run.repoPath);
    if (lock && lock.status === 'quarantined') {
      lock.status = 'released';
    }

    return c.json({ ok: true });
  });

  app.post('/internal/v1/tasks/:id/messages', async (c) => {
    const taskId = c.req.param('id');
    const task = state.tasks.get(taskId);
    if (!task) {
      return c.json({ code: 'NOT_FOUND', message: `task ${taskId} not found` }, 404);
    }

    const parsed = PostTaskMessageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    const body = parsed.data;

    const run = [...state.runs.values()].find(
      (candidate) => candidate.taskId === taskId && candidate.pendingRequestId !== null,
    );
    const pendingRequestId = run?.pendingRequestId ?? null;

    if (!body.inReplyToRequestId || body.inReplyToRequestId !== pendingRequestId) {
      return c.json(
        { code: 'REQUEST_ALREADY_RESOLVED', message: 'no matching pending input request' },
        409,
      );
    }

    if (run) {
      run.pendingRequestId = null;
      run.status = 'running';
    }
    task.status = 'processing';

    return c.json({ ok: true });
  });

  return app;
}
