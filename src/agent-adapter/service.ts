// Agent adapter service routes (SPECIFICATION.md §2, §3; ARCHITECTURE.md §6, §7; TASKS.md T16).
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  CancelRunRequestSchema,
  ProvideInputRequestSchema,
  RunStatusResponseSchema,
  StartRunRequestSchema,
} from '../contracts/index.ts';
import { internalAuth } from '../supervisor/auth.ts';
import { createServiceApp } from '../supervisor/service-app.ts';
import { probeAdapterCapabilities } from './capabilities.ts';
import { registerAdapterErrorHandler } from './errors.ts';
import { AdapterRunManager } from './manager.ts';
import type { FakeScenario } from './types.ts';

export interface CreateAdapterAppOptions {
  port?: number;
  manager?: AdapterRunManager;
  internalToken?: string;
}

export function createAdapterApp(options: CreateAdapterAppOptions = {}): Hono {
  const port = options.port ?? Number(process.env.TASKASIDE_ADAPTER_PORT ?? 0);
  const app = createServiceApp('agent-adapter', port);
  const manager = options.manager ?? new AdapterRunManager();

  registerAdapterErrorHandler(app);

  // Provider capabilities (SPECIFICATION.md §3)
  app.get('/capabilities', (c) => c.json(probeAdapterCapabilities()));

  // Internal routes require 'supervisor' or 'engine' role
  app.use(
    '/internal/v1/*',
    internalAuth(['supervisor', 'engine'], { token: options.internalToken }),
  );

  // Internal connectivity ping
  app.get('/internal/v1/ping', (c) => c.json({ ok: true }));

  // Start run (supports both /runs and /runs/start for harness compatibility)
  const handleStartRun = async (c: import('hono').Context) => {
    const raw = (await c.req.json()) as Record<string, unknown>;
    const parsed = StartRunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    const scenario = raw.scenario as FakeScenario | undefined;
    const result = manager.startRun(parsed.data, { scenario });
    return c.json(result);
  };

  app.post('/internal/v1/runs', handleStartRun);
  app.post('/internal/v1/runs/start', handleStartRun);

  // Status and inspect (supports both /runs/:id and /runs/:id/status)
  const handleGetStatus = (c: import('hono').Context) => {
    const runId = c.req.param('id') ?? '';
    const status = manager.getRunStatus(runId);
    return c.json(RunStatusResponseSchema.parse(status));
  };

  app.get('/internal/v1/runs/:id', handleGetStatus);
  app.get('/internal/v1/runs/:id/status', handleGetStatus);

  // Stream run events over SSE with monotonic sequence and optional ?after=seq replay
  app.get('/internal/v1/runs/:id/events', (c) => {
    const runId = c.req.param('id') ?? '';
    const run = manager.getRun(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `Run ${runId} not found` }, 404);
    }

    const after = Number(c.req.query('after') ?? 0);

    return streamSSE(c, async (stream) => {
      let active = true;
      let done = false;
      const queue: import('../contracts/index.ts').EventEnvelope[] = [];
      let isWriting = false;

      const flushQueue = async () => {
        if (!active || isWriting || queue.length === 0) return;
        isWriting = true;
        try {
          while (queue.length > 0 && active) {
            const event = queue.shift();
            if (event) {
              await stream.writeSSE({ event: 'event', data: JSON.stringify(event) });
            }
          }
        } catch {
          active = false;
        } finally {
          isWriting = false;
        }
      };

      const MAX_SSE_QUEUE_SIZE = 50;
      const PING_INTERVAL_MS = 5000;

      const unsubscribe = manager.subscribeEvents(
        runId,
        after,
        async (event) => {
          if (!active) return;
          if (queue.length >= MAX_SSE_QUEUE_SIZE) {
            // Slow consumer detected: abort stream to protect adapter memory and force reconnect
            active = false;
            unsubscribe();
            return;
          }
          queue.push(event);
          await flushQueue();
        },
        () => {
          done = true;
        },
      );

      stream.onAbort(() => {
        active = false;
        unsubscribe();
      });

      // Flush initial HTTP/SSE headers to client immediately via SSE comment
      await stream.write(': connected\n\n');

      // Flush replayed events immediately
      await flushQueue();

      let lastPingAt = Date.now();

      // Keep open until run is terminal and queue is fully drained
      while (active) {
        if (done && queue.length === 0) {
          break;
        }

        const now = Date.now();
        if (now - lastPingAt >= PING_INTERVAL_MS) {
          lastPingAt = now;
          try {
            await stream.writeSSE({ event: 'ping', data: '{}' });
          } catch {
            active = false;
            break;
          }
        }

        await stream.sleep(25);
      }

      unsubscribe();
    });
  });

  // Provide input to run in HITL state
  app.post('/internal/v1/runs/:id/input', async (c) => {
    const runId = c.req.param('id') ?? '';
    const raw = await c.req.json();
    const parsed = ProvideInputRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    const result = manager.provideInput(runId, parsed.data);
    return c.json(result);
  });

  // Cancel running process tree and verify stopped
  app.post('/internal/v1/runs/:id/cancel', async (c) => {
    const runId = c.req.param('id') ?? '';
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CancelRunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    const result = await manager.cancelRun(runId, parsed.data);
    return c.json(result);
  });

  return app;
}
