// Internal run lifecycle routes (SPECIFICATION.md §3; T12): claim, runnable
// candidates, instruction context, heartbeat, finalize, inspection,
// mark-uncertain and clear-quarantine. Mounted under `/internal/v1/*`, which
// callers must already reach through `internalAuth` (see service-app.ts).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { z } from 'zod';
import { CreateMessageInputSchema } from '../../contracts/chat.ts';
import { IngestEventsRequestSchema } from '../../contracts/event.ts';
import {
  AdmitTaskRequestSchema,
  ClaimTaskRequestSchema,
  ClearQuarantineRequestSchema,
  HeartbeatRequestSchema,
  MarkUncertainRequestSchema,
  VerificationMethodSchema,
} from '../../contracts/run.ts';
import { internalAuth } from '../../supervisor/auth.ts';
import { appendMessage, getConversationIdForTask } from '../domains/chat/messages.ts';
import { ingestEvents } from '../domains/task/events.ts';
import {
  admitNextEligibleTask,
  claimTask,
  clearQuarantine,
  finalizeRun,
  getRunStatus,
  getTaskContext,
  heartbeat,
  listActiveRuns,
  listRunnableTasks,
  markUncertain,
  requestTimeout,
} from '../domains/task/runs.ts';
import { mintManagedMcpToken } from '../mcp/tokens.ts';
import { DomainError } from './errors.ts';

// Deliberately not the refined `FinalizeRunRequestSchema`: that schema's
// `.refine` rejects `verifiedStopped:false` at the zod layer, which would
// surface as `VALIDATION_ERROR` instead of the domain-specific
// `VERIFIED_STOP_REQUIRED` the contract requires (SPECIFICATION.md §3).
// Shape validation happens here; the verified-stop invariant is enforced by
// `finalizeRun` itself.
const FinalizeRequestBodySchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  status: z.enum(['done', 'error', 'cancelled']),
  verifiedStopped: z.boolean(),
  verificationMethod: VerificationMethodSchema.optional(),
  summary: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

export function mountInternalRunRoutes(app: Hono, db: Database): void {
  app.get('/internal/v1/tasks/runnable', (c) => c.json(listRunnableTasks(db)));

  // Startup reconciliation feed: runs still 'running'/'hitl' in the database,
  // independent of any in-process engine state (specs/2026-10-24-handoff
  // -single-writer.md A9 — persisted ownership must survive an engine
  // restart).
  app.get('/internal/v1/runs/active', (c) => c.json(listActiveRuns(db)));

  app.post('/internal/v1/tasks/:id/claim', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ClaimTaskRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid claim request', parsed.error.flatten());
    }
    return c.json(claimTask(db, c.req.param('id'), parsed.data));
  });

  // Atomic bulk admission (specs/2026-10-24-polling-worker-pool.md): the
  // backend selects the next eligible task itself via a short indexed query
  // and claims it in one call, replacing the engine's old full-backlog
  // fetch-then-claim-by-id loop. A normal "nothing to admit" outcome is 200,
  // not an error — only request/auth problems use 4xx/5xx.
  app.post('/internal/v1/tasks/admit', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AdmitTaskRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid admit request', parsed.error.flatten());
    }
    return c.json(admitNextEligibleTask(db, parsed.data));
  });

  app.get('/internal/v1/tasks/:id/context', (c) => c.json(getTaskContext(db, c.req.param('id'))));

  app.post('/internal/v1/runs/:id/heartbeat', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = HeartbeatRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'invalid heartbeat request',
        parsed.error.flatten(),
      );
    }
    return c.json(heartbeat(db, c.req.param('id'), parsed.data));
  });

  app.post('/internal/v1/runs/:id/finalize', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = FinalizeRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid finalize request', parsed.error.flatten());
    }
    return c.json(finalizeRun(db, c.req.param('id'), parsed.data));
  });

  app.get('/internal/v1/runs/:id', (c) => c.json(getRunStatus(db, c.req.param('id'))));

  app.post('/internal/v1/runs/:id/request-timeout', (c) =>
    c.json(requestTimeout(db, c.req.param('id'))),
  );

  app.post('/internal/v1/runs/:id/mark-uncertain', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = MarkUncertainRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'invalid mark-uncertain request',
        parsed.error.flatten(),
      );
    }
    return c.json(markUncertain(db, c.req.param('id'), parsed.data));
  });

  // Admin-only override: restrict beyond the broader engine/supervisor gate
  // already applied to `/internal/v1/*`.
  app.post('/internal/v1/runs/:id/clear-quarantine', internalAuth(['supervisor']), async (c) => {
    const id = c.req.param('id');
    if (!id) {
      throw new DomainError('VALIDATION_ERROR', 'missing run id');
    }
    const body = await c.req.json().catch(() => null);
    const parsed = ClearQuarantineRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'invalid clear-quarantine request',
        parsed.error.flatten(),
      );
    }
    return c.json(clearQuarantine(db, id, parsed.data));
  });

  app.post('/internal/v1/runs/:id/events', async (c) => {
    const runId = c.req.param('id');
    const rawBody = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!rawBody || typeof rawBody !== 'object') {
      throw new DomainError('VALIDATION_ERROR', 'invalid event request body');
    }
    const bodyWithEvents = {
      ...rawBody,
      events: Array.isArray(rawBody.events)
        ? rawBody.events
        : rawBody.event
          ? [rawBody.event]
          : rawBody.events,
    };
    const parsed = IngestEventsRequestSchema.safeParse(bodyWithEvents);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid event envelope', parsed.error.flatten());
    }

    const result = ingestEvents(db, runId, parsed.data);

    // Header hook for deterministic dropped-ACK testing
    if (c.req.header('x-simulate-lost-ack') === 'true') {
      return c.text('simulated dropped ack', 503);
    }

    return c.json(result);
  });

  app.post('/internal/v1/tasks/:id/messages', async (c) => {
    const taskId = c.req.param('id');
    const conversationId = getConversationIdForTask(db, taskId);
    if (!conversationId) {
      throw new DomainError('NOT_FOUND', `task not found: ${taskId}`);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = CreateMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'invalid message input', parsed.error.flatten());
    }
    const message = appendMessage(db, conversationId, parsed.data, 'user');
    return c.json({ ok: true, message });
  });

  app.post('/internal/v1/runs/:id/mcp-token', (c) => {
    const runId = c.req.param('id');
    const runRow = db.query('SELECT task_id FROM runs WHERE id = ?').get(runId) as {
      task_id: string;
    } | null;
    if (!runRow) {
      throw new DomainError('NOT_FOUND', `run not found: ${runId}`);
    }
    return c.json(mintManagedMcpToken(db, runId, runRow.task_id), 201);
  });
}
