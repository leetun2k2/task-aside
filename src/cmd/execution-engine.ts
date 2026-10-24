// Execution engine entrypoint (ARCHITECTURE.md §2.2): scheduling, instruction
// building, dispatch and reconciliation against backend/adapter. No direct SQLite
// access and no provider subprocess spawn.
// Exposes only `/health` for readiness; the engine has no `/internal/v1/*`
// endpoints of its own (it is a caller of backend/adapter internal routes).
import {
  AdapterClient,
  BackendClient,
  EngineRuntime,
  RunDispatcher,
  RunReconciler,
  TaskScheduler,
} from '../execution-engine/index.ts';
import { createServiceApp } from '../supervisor/service-app.ts';

const port = Number(process.env.TASKASIDE_ENGINE_PORT ?? 0);
const backendPort = Number(process.env.TASKASIDE_BACKEND_PORT ?? 0);
const adapterPort = Number(process.env.TASKASIDE_ADAPTER_PORT ?? 0);
const internalToken = process.env.TASKASIDE_INTERNAL_TOKEN ?? '';
// Test-only: forces fake-provider scenarios through the real HTTP dispatch
// path (see EngineRuntimeOptions.defaultScenario doc comment). Unset in
// normal operation.
const fakeScenario = process.env.TASKASIDE_ENGINE_FAKE_SCENARIO as
  | 'success'
  | 'failure'
  | 'hitl'
  | 'duplicate_events'
  | 'disconnect'
  | 'crash'
  | undefined;

const app = createServiceApp('execution-engine', port);

let scheduler: TaskScheduler | null = null;
let dispatcher: RunDispatcher | null = null;
let reconciler: RunReconciler | null = null;
let runtime: EngineRuntime | null = null;
if (backendPort && internalToken) {
  const backendClient = new BackendClient({
    baseUrl: `http://127.0.0.1:${backendPort}`,
    internalToken,
    role: 'engine',
  });
  scheduler = new TaskScheduler(backendClient, {
    ownerId: `engine_${process.pid}`,
  });
  if (adapterPort) {
    const adapterClient = new AdapterClient({
      baseUrl: `http://127.0.0.1:${adapterPort}`,
      internalToken,
      role: 'engine',
    });
    dispatcher = new RunDispatcher(backendClient, adapterClient, scheduler, {
      ownerId: `engine_${process.pid}`,
      heartbeatIntervalMs: 5_000,
    });
    reconciler = new RunReconciler(backendClient, adapterClient, scheduler, {
      ownerId: `engine_${process.pid}`,
    });
    runtime = new EngineRuntime(backendClient, adapterClient, scheduler, dispatcher, reconciler, {
      ownerId: `engine_${process.pid}`,
      defaultScenario: fakeScenario,
    });
    // Fire-and-forget: the HTTP server (default export below) is what keeps
    // this process alive and serves /health; the runtime loop drives
    // scheduling/dispatch/reconciliation/HITL-resume/cancellation
    // concurrently with it. A loop-level error is logged, not fatal — see
    // EngineRuntime's per-iteration try/catch.
    runtime.start().catch((err) => {
      console.error('[execution-engine] runtime failed to start:', err);
    });
  }
}

let stopping = false;
const handleShutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  if (runtime) {
    try {
      await runtime.stop();
    } catch (err) {
      console.error(`[execution-engine] error stopping runtime on ${signal}:`, err);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

export { scheduler, dispatcher, reconciler, runtime };

export default {
  port,
  hostname: '127.0.0.1',
  fetch: app.fetch,
};
