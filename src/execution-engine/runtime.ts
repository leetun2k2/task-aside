// Execution engine runtime loop (specs/2026-10-24-handoff-single-writer.md):
// drives the scheduler/dispatcher/reconciler automatically at service startup
// instead of leaving them as unused exports. Owns: startup reconciliation of
// persisted runs, the poll-schedule-dispatch loop, matched-HITL-reply
// resumption, and cooperative cancellation of live runs.
// Architecture boundary: no direct SQLite access in execution engine.
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  CONTROL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  SHUTDOWN_DRAIN_MS,
  STOP_VERIFICATION_BOUND_MS,
} from '../contracts/pool.ts';
import type { AdapterClient, BackendClient } from './client.ts';
import type { RunDispatcher } from './dispatcher.ts';
import type { RunReconciler } from './reconciler.ts';
import type { TaskScheduler } from './scheduler.ts';
import type { DispatchResult, RunStatusRecord } from './types.ts';

export interface EngineRuntimeOptions {
  ownerId: string;
  /** Poll loop cadence for admissions. Default 100ms (POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
  /** Control loop cadence for settings/HITL/cancel/deadlines. Default 1000ms (CONTROL_INTERVAL_MS). */
  controlIntervalMs?: number;
  /**
   * Test-only hook: forces every dispatched run through the adapter's fake
   * scenario path instead of a real provider driver. Undefined in normal
   * operation. Never invents provider capabilities — the adapter itself
   * already supports `scenario` as a request-body override on real HTTP
   * (see src/agent-adapter/service.ts), this just threads it through so
   * process/contract checks can exercise the real engine loop without a
   * live Codex/Claude CLI.
   */
  defaultScenario?: 'success' | 'failure' | 'hitl' | 'duplicate_events' | 'disconnect' | 'crash';
  onError?: (context: string, err: unknown) => void;
}

interface HitlWatch {
  taskId: string;
  requestId: string;
}

export class EngineRuntime {
  private backendClient: BackendClient;
  private adapterClient: AdapterClient;
  private scheduler: TaskScheduler;
  private dispatcher: RunDispatcher;
  private reconciler: RunReconciler;
  private options: EngineRuntimeOptions;

  private stopped = false;
  private admissionLoopPromise: Promise<void> | null = null;
  private controlLoopPromise: Promise<void> | null = null;
  private hitlWatches = new Map<string, HitlWatch>();
  private cancelActioned = new Set<string>();
  private timeoutActioned = new Set<string>();
  private inFlight = new Set<string>();

  constructor(
    backendClient: BackendClient,
    adapterClient: AdapterClient,
    scheduler: TaskScheduler,
    dispatcher: RunDispatcher,
    reconciler: RunReconciler,
    options: EngineRuntimeOptions,
  ) {
    this.backendClient = backendClient;
    this.adapterClient = adapterClient;
    this.scheduler = scheduler;
    this.dispatcher = dispatcher;
    this.reconciler = reconciler;
    this.options = options;
  }

  private reportError(context: string, err: unknown): void {
    if (this.options.onError) {
      this.options.onError(context, err);
    } else {
      console.error(`[execution-engine] ${context}:`, err instanceof Error ? err.message : err);
    }
  }

  async start(): Promise<void> {
    await this.reconcileOnStartup();
    await this.scheduler
      .syncSettings()
      .catch((err) => this.reportError('syncSettings startup', err));
    this.admissionLoopPromise = this.admissionLoop();
    this.controlLoopPromise = this.controlLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;

    // Drain in-flight dispatches for up to SHUTDOWN_DRAIN_MS (30s)
    const drainDeadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while (this.inFlight.size > 0 && Date.now() < drainDeadline) {
      await sleep(100);
    }

    if (this.admissionLoopPromise) {
      await this.admissionLoopPromise;
    }
    if (this.controlLoopPromise) {
      await this.controlLoopPromise;
    }

    // Bounded termination for any still-active runs
    const activeRuns = this.scheduler.getActiveRuns();
    for (const run of activeRuns) {
      try {
        const stopPromise = this.dispatcher.cancelRun(run.runId, run.generation);
        const timeoutPromise = sleep(STOP_VERIFICATION_BOUND_MS).then(() => null);
        const res = await Promise.race([stopPromise, timeoutPromise]);
        if (!res || !res.verifiedStopped) {
          try {
            await this.backendClient.markUncertain(run.runId, {
              ownerId: this.options.ownerId,
              generation: run.generation,
              reason: 'Shutdown: process stop unverified within bound',
            });
          } catch {
            // Backend unreachable: leave existing reservation alone
          }
        }
      } catch {
        try {
          await this.backendClient.markUncertain(run.runId, {
            ownerId: this.options.ownerId,
            generation: run.generation,
            reason: 'Shutdown: process stop error',
          });
        } catch {
          // Backend unreachable: leave existing reservation alone
        }
      }
    }
  }

  /**
   * Reconciles persisted active runs against real adapter process state
   * before accepting new work, so a restarted engine never claims a second
   * writer on a checkout an old (possibly still-exiting) process might hold.
   */
  private async reconcileOnStartup(): Promise<void> {
    let activeRuns: RunStatusRecord[] = [];
    try {
      activeRuns = await this.backendClient.listActiveRuns();
    } catch (err) {
      this.reportError('startup reconciliation: failed to list active runs', err);
      return;
    }

    for (const run of activeRuns) {
      try {
        const result = await this.reconciler.reconcileRun(run.runId, run.generation);
        if (!result.reconciled) {
          // Adapter confirms the run is still legitimately running/hitl:
          // restore in-memory concurrency/tree-busy accounting so this
          // process doesn't over-claim beyond the configured ceiling.
          await this.rehydrateActiveRun(run);
        }
      } catch (err) {
        this.reportError(`startup reconciliation: run ${run.runId}`, err);
      }
    }
  }

  private async rehydrateActiveRun(run: RunStatusRecord): Promise<void> {
    try {
      const context = await this.backendClient.getTaskContext(run.taskId);
      this.scheduler.recordActiveRun({
        runId: run.runId,
        taskId: run.taskId,
        workingTreeKey: context.repository.canonicalPath,
        generation: run.generation,
        priority: context.task.priority,
        startedAt: run.startedAt,
      });
      if (run.status === 'hitl' && run.pendingInputRequestId) {
        this.hitlWatches.set(run.runId, {
          taskId: run.taskId,
          requestId: run.pendingInputRequestId,
        });
      }
    } catch (err) {
      this.reportError(`startup reconciliation: failed to rehydrate run ${run.runId}`, err);
    }
  }

  private async admissionLoop(): Promise<void> {
    let backoffMs = 0;
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;

    while (!this.stopped) {
      let sleepMs = interval;
      try {
        const step = await this.scheduler.scheduleNext();
        backoffMs = 0; // Successfully communicated with backend
        if (step.claimed && step.runId && step.taskId) {
          this.dispatchClaimed(step.taskId, step.runId, step.generation ?? 1);
        }
      } catch (err) {
        this.reportError('scheduleNext', err);
        // Unreachable / connection failure backoff with jitter
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
        const jitter = Math.random() * (backoffMs * 0.2);
        sleepMs = backoffMs + jitter;
      }

      if (!this.stopped) {
        await sleep(sleepMs);
      }
    }
  }

  private async controlLoop(): Promise<void> {
    const interval = this.options.controlIntervalMs ?? CONTROL_INTERVAL_MS;

    while (!this.stopped) {
      try {
        await this.scheduler.syncSettings();
      } catch (err) {
        this.reportError('syncSettings', err);
      }

      try {
        await this.checkHitlResumes();
      } catch (err) {
        this.reportError('checkHitlResumes', err);
      }

      try {
        await this.checkCancelRequests();
      } catch (err) {
        this.reportError('checkCancelRequests', err);
      }

      try {
        await this.checkDeadlineTimeouts();
      } catch (err) {
        this.reportError('checkDeadlineTimeouts', err);
      }

      if (!this.stopped) {
        await sleep(interval);
      }
    }
  }

  private async checkDeadlineTimeouts(): Promise<void> {
    const now = Date.now();
    for (const run of this.scheduler.getActiveRuns()) {
      if (this.timeoutActioned.has(run.runId)) {
        continue;
      }
      let status: RunStatusRecord;
      try {
        status = await this.backendClient.getRun(run.runId);
      } catch {
        continue;
      }

      const deadline = new Date(status.deadlineAt).getTime();
      if (now >= deadline) {
        this.timeoutActioned.add(run.runId);
        try {
          if (!status.timeoutRequestedAt) {
            await this.backendClient.requestTimeout(run.runId).catch(() => {});
          }
          await this.dispatcher.enforceTimeout(run.runId, run.generation);
        } catch (err) {
          this.reportError(`enforceTimeout run ${run.runId}`, err);
        }
      }
    }

    const activeIds = new Set(this.scheduler.getActiveRuns().map((r) => r.runId));
    for (const runId of [...this.timeoutActioned]) {
      if (!activeIds.has(runId)) {
        this.timeoutActioned.delete(runId);
      }
    }
  }

  private dispatchClaimed(taskId: string, runId: string, generation: number): void {
    if (this.inFlight.has(runId)) {
      return;
    }
    this.inFlight.add(runId);

    (async () => {
      try {
        const [context, run] = await Promise.all([
          this.backendClient.getTaskContext(taskId),
          this.backendClient.getRun(runId),
        ]);
        const result = await this.dispatcher.dispatchTask({
          task: context.task,
          claim: { runId, generation },
          context,
          // The run's own `provider` column (set from the repo's
          // defaultProvider at claim time) is authoritative — dispatchTask
          // itself silently defaults to 'codex' when omitted, which would
          // otherwise always run Codex regardless of what was configured.
          provider: run.provider === 'claude' ? 'claude' : 'codex',
          scenario: this.options.defaultScenario,
        });
        this.afterDispatch(runId, taskId, result);
      } catch (err) {
        this.reportError(`dispatch run ${runId}`, err);
      } finally {
        this.inFlight.delete(runId);
      }
    })().catch((err) => this.reportError(`dispatch run ${runId} (unhandled)`, err));
  }

  private afterDispatch(runId: string, taskId: string, result: DispatchResult): void {
    if (result.status === 'hitl') {
      // Find the pending request id from the task context the dispatcher just
      // observed; re-fetch is cheap and keeps this method synchronous-ish.
      this.backendClient
        .getRun(runId)
        .then((run) => {
          if (run.pendingInputRequestId) {
            this.hitlWatches.set(runId, { taskId, requestId: run.pendingInputRequestId });
          }
        })
        .catch((err) => this.reportError(`register hitl watch for run ${runId}`, err));
    }
  }

  /**
   * Detects a matched HITL reply (the backend already atomically paired it in
   * `appendMessage` — pending_input_request_id cleared, run back to
   * 'running') and resumes execution on the adapter. There is no shared
   * memory/mandatory event broker (AGENTS.md §5), so this is polled.
   */
  private async checkHitlResumes(): Promise<void> {
    for (const [runId, watch] of [...this.hitlWatches.entries()]) {
      let run: RunStatusRecord;
      try {
        run = await this.backendClient.getRun(runId);
      } catch {
        this.hitlWatches.delete(runId);
        continue;
      }

      if (run.status === 'hitl' || run.pendingInputRequestId) {
        continue; // still waiting on a human reply
      }
      if (run.status !== 'running') {
        // Run ended some other way (cancelled/finalized) while awaiting input.
        this.hitlWatches.delete(runId);
        continue;
      }

      this.hitlWatches.delete(runId);
      try {
        const context = await this.backendClient.getTaskContext(watch.taskId);
        const reply = [...context.messages]
          .reverse()
          .find((m) => m.inReplyToRequestId === watch.requestId);

        const result = await this.dispatcher.resumeHitlTask({
          task: context.task,
          claim: { runId, generation: run.generation },
          context,
          response: reply?.content ?? '',
          requestId: watch.requestId,
          provider: run.provider === 'claude' ? 'claude' : 'codex',
          scenario: this.options.defaultScenario,
        });

        this.afterDispatch(runId, watch.taskId, result);
      } catch (err) {
        this.reportError(`resume hitl run ${runId}`, err);
      }
    }
  }

  /**
   * Detects a cooperative cancel request (set by
   * `requestRunCancellationForTask` when a user cancels a live/processing or
   * hitl task) on a run this process is actively dispatching, and cancels it
   * on the adapter with verified-stop proof before the backend finalizes it.
   */
  private async checkCancelRequests(): Promise<void> {
    for (const run of this.scheduler.getActiveRuns()) {
      if (this.cancelActioned.has(run.runId)) {
        continue;
      }
      let status: RunStatusRecord;
      try {
        status = await this.backendClient.getRun(run.runId);
      } catch {
        continue;
      }
      if (!status.cancelRequestedAt) {
        continue;
      }
      this.cancelActioned.add(run.runId);
      try {
        await this.dispatcher.cancelRun(run.runId, run.generation);
      } catch (err) {
        this.reportError(`cancel run ${run.runId}`, err);
      }
    }

    // Bound memory: drop actioned entries for runs no longer tracked active.
    const activeIds = new Set(this.scheduler.getActiveRuns().map((r) => r.runId));
    for (const runId of [...this.cancelActioned]) {
      if (!activeIds.has(runId)) {
        this.cancelActioned.delete(runId);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
