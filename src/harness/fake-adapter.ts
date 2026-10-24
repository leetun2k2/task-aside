// Fake agent adapter for the deterministic run harness (T09, ARCHITECTURE.md §2.3):
// emits scripted event sequences over SSE without any real Codex/Claude process.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  CancelRunRequestSchema,
  CapabilitiesResponseSchema,
  type EventEnvelope,
  ProvideInputRequestSchema,
  RunStatusResponseSchema,
  StartRunRequestSchema,
} from '../contracts/index.ts';
import { internalAuth } from '../supervisor/auth.ts';
import { hostOriginGuard } from '../supervisor/host-origin.ts';

export type FakeAdapterScenario =
  'success' | 'failure' | 'hitl' | 'duplicate_events' | 'disconnect' | 'crash';

type AdapterRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'hitl';

interface AdapterRunRecord {
  runId: string;
  ownerId: string;
  generation: number;
  scenario: FakeAdapterScenario;
  events: EventEnvelope[];
  status: AdapterRunStatus;
  lastSequence: number;
  pendingRequestId: string | null;
  verifiedStoppedAt: string | null;
  verificationMethod: 'process_group_empty' | 'ps_fingerprint_absent' | null;
  exitCode: number | null;
}

export interface FakeAdapterState {
  runs: Map<string, AdapterRunRecord>;
}

export function createFakeAdapterState(): FakeAdapterState {
  return { runs: new Map() };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function delta(sequence: number, text: string): EventEnvelope {
  return {
    runId: '',
    sequence,
    type: 'message.delta',
    timestamp: iso(sequence),
    data: { messageId: 'm1', delta: text },
  };
}

function buildScenarioEvents(scenario: FakeAdapterScenario): EventEnvelope[] {
  switch (scenario) {
    case 'success':
      return [
        delta(1, 'Working'),
        {
          runId: '',
          sequence: 2,
          type: 'message.completed',
          timestamp: iso(2),
          data: { messageId: 'm1', content: 'Working on it, done.' },
        },
        {
          runId: '',
          sequence: 3,
          type: 'completed',
          timestamp: iso(3),
          data: { summary: 'Task completed' },
        },
      ];
    case 'failure':
      return [
        delta(1, 'Trying'),
        {
          runId: '',
          sequence: 2,
          type: 'failed',
          timestamp: iso(2),
          data: { errorCode: 'AGENT_ERROR', message: 'simulated agent failure' },
        },
      ];
    case 'hitl':
      return [
        {
          runId: '',
          sequence: 1,
          type: 'message.completed',
          timestamp: iso(1),
          data: { messageId: 'm1', content: 'I need more information.' },
        },
        {
          runId: '',
          sequence: 2,
          type: 'input_required',
          timestamp: iso(2),
          data: { requestId: 'req_1', question: 'Which environment should I target?' },
        },
      ];
    case 'duplicate_events':
      return [
        delta(1, 'First'),
        delta(1, 'First'),
        {
          runId: '',
          sequence: 2,
          type: 'completed',
          timestamp: iso(2),
          data: { summary: 'Task completed' },
        },
      ];
    case 'disconnect':
      // Only ever emits one event; the stream ends mid-run with no terminal
      // event, modeling an SSE connection that dies before completion.
      return [delta(1, 'Starting')];
    case 'crash':
      return [];
    default:
      return [];
  }
}

// Standalone Hono app bound to 127.0.0.1 by the caller. Mirrors
// SPECIFICATION.md §3's agent-adapter internal endpoints against scripted state.
export function createFakeAdapter(
  port: number,
  state: FakeAdapterState = createFakeAdapterState(),
): Hono {
  const app = new Hono();
  app.use('*', hostOriginGuard(port));
  app.use('/internal/v1/*', internalAuth(['engine', 'supervisor']));

  app.get('/health', (c) => c.json({ status: 'ok', service: 'fake-adapter' }));

  app.get('/capabilities', (c) =>
    c.json(
      CapabilitiesResponseSchema.parse({
        providers: {
          codex: { available: true, resume: false, mcp: false },
          claude: { available: true, resume: true, mcp: true },
        },
      }),
    ),
  );

  app.post('/internal/v1/runs/start', async (c) => {
    const raw = (await c.req.json()) as Record<string, unknown>;
    const parsed = StartRunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }
    const body = parsed.data;
    const scenario = (raw.scenario as FakeAdapterScenario | undefined) ?? 'success';

    if (state.runs.has(body.runId)) {
      // Idempotent restart: a repeated start call never spawns a second run.
      return c.json({ runId: body.runId, started: true });
    }

    const events = buildScenarioEvents(scenario).map((event) => ({ ...event, runId: body.runId }));
    state.runs.set(body.runId, {
      runId: body.runId,
      ownerId: body.ownerId,
      generation: body.generation,
      scenario,
      events,
      status: 'running',
      lastSequence: 0,
      pendingRequestId: null,
      verifiedStoppedAt: null,
      verificationMethod: null,
      exitCode: null,
    });

    return c.json({ runId: body.runId, started: true });
  });

  app.get('/internal/v1/runs/:id/events', (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    return streamSSE(c, async (stream) => {
      for (const event of run.events) {
        await stream.writeSSE({ event: 'event', data: JSON.stringify(event) });
        run.lastSequence = event.sequence;
        if (event.type === 'input_required') {
          run.pendingRequestId = event.data.requestId;
          run.status = 'hitl';
        }
        if (event.type === 'completed') {
          run.status = 'completed';
        }
        if (event.type === 'failed') {
          run.status = 'failed';
        }
        await stream.sleep(1);
      }
      // Scenarios other than 'disconnect'/'hitl'/'crash' end with a terminal
      // event above; those three intentionally leave the stream open-ended to
      // model a dropped connection, a safe pause, or a dead adapter.
    });
  });

  app.get('/internal/v1/runs/:id/status', (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    let processStatus: 'done' | 'error' | AdapterRunStatus = run.status;
    if (run.status === 'completed') {
      processStatus = 'done';
    } else if (run.status === 'failed') {
      processStatus = 'error';
    }

    const response = RunStatusResponseSchema.parse({
      runId,
      processState: {
        status: processStatus,
        verifiedStoppedAt: run.verifiedStoppedAt,
        verificationMethod: run.verificationMethod,
        exitCode: run.exitCode,
      },
    });
    return c.json(response);
  });

  app.post('/internal/v1/runs/:id/cancel', async (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    const raw = await c.req.json().catch(() => ({}));
    const parsed = CancelRunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }

    run.status = 'cancelled';
    run.verifiedStoppedAt = new Date().toISOString();
    run.verificationMethod = 'process_group_empty';
    run.exitCode = 143;

    return c.json({
      runId,
      verifiedStopped: true,
      verificationMethod: 'process_group_empty' as const,
    });
  });

  app.post('/internal/v1/runs/:id/input', async (c) => {
    const runId = c.req.param('id');
    const run = state.runs.get(runId);
    if (!run) {
      return c.json({ code: 'NOT_FOUND', message: `run ${runId} not found` }, 404);
    }

    const raw = await c.req.json().catch(() => ({}));
    const parsed = ProvideInputRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);
    }

    if (parsed.data.ownerId !== run.ownerId || parsed.data.generation !== run.generation) {
      return c.json({ code: 'STALE_GENERATION', message: 'owner or generation mismatch' }, 409);
    }

    if (run.status !== 'hitl') {
      return c.json(
        { code: 'REQUEST_ALREADY_RESOLVED', message: `run is in ${run.status}, not hitl` },
        409,
      );
    }

    if (
      parsed.data.requestId &&
      run.pendingRequestId &&
      parsed.data.requestId !== run.pendingRequestId
    ) {
      return c.json({ code: 'REQUEST_ALREADY_RESOLVED', message: 'request id mismatch' }, 409);
    }

    run.pendingRequestId = null;
    run.status = 'running';

    const nextSeq = run.lastSequence + 1;
    run.events.push({
      runId,
      sequence: nextSeq,
      type: 'completed',
      timestamp: new Date().toISOString(),
      data: { summary: `Completed after input: ${parsed.data.response}` },
    });

    return c.json({ ok: true });
  });

  return app;
}
