// Execution engine run dispatcher and event forwarder (ARCHITECTURE.md §2.2, §5; SPECIFICATION.md §2, §3; TASKS.md T21).
// Coordinates backend claim -> adapter start -> SSE event ingestion -> delta coalescing ->
// durable event forwarding/retries -> disconnect recovery -> verified-stop finalization.
// Architecture boundary: no direct SQLite access and no provider subprocess spawn.
//
// Per-run isolation (specs/2026-10-24-polling-worker-pool.md): a single
// `RunDispatcher` instance now drives up to MAX_WORKERS concurrent
// dispatchTask()/streamEventsToTermination() calls (one engine runtime, one
// pool of slots). Every piece of per-attempt mutable state — the coalesced
// delta, its flush timer, the last acknowledged sequence cursor — lives in a
// `Map<runId, RunStreamState>` keyed by run, never on instance fields, so
// concurrent runs can never stomp each other's cursor/delta/timer. Reusing a
// slot for a different run never reuses the prior run's entry: each entry is
// created fresh on dispatch/resume and deleted once that run's monitoring
// ends (bounded memory, no leaked timers/listeners).
import { type EventEnvelope, PERSISTENT_EVENT_TYPES } from '../contracts/event.ts';
import type { ClaimTaskResponse } from '../contracts/run.ts';
import {
  type AdapterClient,
  AdapterClientError,
  type BackendClient,
  BackendClientError,
} from './client.ts';
import { buildTaskInstruction } from './instruction-builder.ts';
import type { TaskScheduler } from './scheduler.ts';
import type {
  DispatchResult,
  DispatcherOptions,
  ResumeHitlParams,
  TaskContext,
  TaskRecord,
} from './types.ts';

interface PendingDelta {
  runId: string;
  generation: number;
  messageId: string;
  accumulatedDelta: string;
  lastSequence: number;
  timestamp: string;
}

interface RunStreamState {
  pendingDelta: PendingDelta | null;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  lastAcknowledgedSequence: number;
  forwardedEvents: EventEnvelope[];
}

function freshStreamState(startAfter: number): RunStreamState {
  return {
    pendingDelta: null,
    deltaTimer: null,
    lastAcknowledgedSequence: startAfter,
    forwardedEvents: [],
  };
}

export interface DispatchTaskParams {
  task: TaskRecord;
  claim: ClaimTaskResponse | { runId: string; generation: number; [key: string]: unknown };
  context: TaskContext;
  provider?: 'codex' | 'claude';
  scenario?: string; // For testing fake adapter scenarios
  simulateLostAck?: boolean;
}

export class RunDispatcher {
  private backendClient: BackendClient;
  private adapterClient: AdapterClient;
  private scheduler: TaskScheduler;
  private options: DispatcherOptions;

  private runStates = new Map<string, RunStreamState>();

  constructor(
    backendClient: BackendClient,
    adapterClient: AdapterClient,
    scheduler: TaskScheduler,
    options: DispatcherOptions,
  ) {
    this.backendClient = backendClient;
    this.adapterClient = adapterClient;
    this.scheduler = scheduler;
    this.options = options;
  }

  private stateFor(runId: string): RunStreamState {
    let state = this.runStates.get(runId);
    if (!state) {
      state = freshStreamState(0);
      this.runStates.set(runId, state);
    }
    return state;
  }

  getLastAcknowledgedSequence(runId: string): number {
    return this.runStates.get(runId)?.lastAcknowledgedSequence ?? 0;
  }

  getForwardedEvents(runId: string): EventEnvelope[] {
    return [...(this.runStates.get(runId)?.forwardedEvents ?? [])];
  }

  /** Retires a run's stream state — call once its monitoring has definitely
   * ended (terminal finalize, uncertain, or resume handed off) so slots don't
   * leak timers/memory across reuse. */
  private retire(runId: string): void {
    const state = this.runStates.get(runId);
    if (state?.deltaTimer) {
      clearTimeout(state.deltaTimer);
    }
    this.runStates.delete(runId);
  }

  /**
   * Flushes any pending coalesced delta immediately to the backend, for ONE
   * run's isolated state.
   */
  async flushPendingDelta(runId: string): Promise<void> {
    const state = this.stateFor(runId);
    if (state.deltaTimer) {
      clearTimeout(state.deltaTimer);
      state.deltaTimer = null;
    }
    if (!state.pendingDelta) {
      return;
    }

    const delta = state.pendingDelta;
    state.pendingDelta = null;

    const event: EventEnvelope = {
      runId: delta.runId,
      sequence: delta.lastSequence,
      type: 'message.delta',
      timestamp: delta.timestamp,
      data: {
        messageId: delta.messageId,
        delta: delta.accumulatedDelta,
      },
    };

    await this.forwardWithRetry(delta.runId, delta.generation, [event]);
    state.lastAcknowledgedSequence = Math.max(state.lastAcknowledgedSequence, delta.lastSequence);
  }

  /**
   * Forwards durable events to backend with retry on transient failures (e.g. lost ACKs).
   * Identical event tuples (runId, sequence, type, data) are resent unchanged.
   */
  async forwardWithRetry(
    runId: string,
    generation: number,
    events: EventEnvelope[],
    headers?: Record<string, string>,
  ): Promise<void> {
    const maxRetries = this.options.maxRetries ?? 3;
    let attempt = 0;
    const state = this.stateFor(runId);

    while (true) {
      attempt++;
      try {
        // Extra headers (such as x-simulate-lost-ack) are applied on attempt 1;
        // subsequent retries send the clean request to verify idempotent recovery.
        const requestHeaders = attempt === 1 ? headers : undefined;
        await this.backendClient.postEvents(
          runId,
          {
            ownerId: this.options.ownerId,
            generation,
            events,
          },
          requestHeaders,
        );
        state.forwardedEvents.push(...events);
        return;
      } catch (err: unknown) {
        if (err instanceof BackendClientError) {
          // Stale generation or sequence conflict is non-retriable
          if (err.status === 409) {
            throw err;
          }
          if (err.status < 500 && err.status !== 408) {
            throw err;
          }
        }
        if (attempt >= maxRetries) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, this.options.retryDelayMs ?? 20));
      }
    }
  }

  /**
   * Cancels an active run on the adapter, verifies stop, and finalizes on backend.
   * If stop cannot be verified, marks uncertain to quarantine the working tree.
   */
  async cancelRun(
    runId: string,
    generation: number,
  ): Promise<{ ok: boolean; verifiedStopped: boolean; status: 'cancelled' | 'uncertain' }> {
    try {
      const cancelResult = await this.adapterClient.cancelRun(runId, {
        ownerId: this.options.ownerId,
        generation,
      });

      if (cancelResult.verifiedStopped) {
        await this.backendClient.finalize(runId, {
          ownerId: this.options.ownerId,
          generation,
          status: 'cancelled',
          verifiedStopped: true,
          verificationMethod: cancelResult.verificationMethod ?? 'process_group_empty',
        });
        this.scheduler.releaseRun(runId);
        this.retire(runId);
        return { ok: true, verifiedStopped: true, status: 'cancelled' };
      }
    } catch {
      // Cancel failed or could not verify stop
    }

    try {
      await this.backendClient.markUncertain(runId, {
        ownerId: this.options.ownerId,
        generation,
        reason: 'Cancel failed: could not verify process tree stopped',
      });
    } catch {
      // Ignore
    }
    this.scheduler.releaseRun(runId);
    this.retire(runId);
    return { ok: false, verifiedStopped: false, status: 'uncertain' };
  }

  /**
   * Enforces the durable per-attempt deadline (specs/2026-10-24-polling-worker-pool.md):
   * requests process-tree termination exactly like `cancelRun`, but on
   * verified stop finalizes as `status:'error', errorCode:'TIMEOUT'` instead
   * of `cancelled`, so the reason stays distinguishable in conversation/
   * diagnostics. On failure to verify, quarantines exactly like `cancelRun` —
   * missing proof never becomes silent success.
   */
  async enforceTimeout(
    runId: string,
    generation: number,
  ): Promise<{ ok: boolean; verifiedStopped: boolean; status: 'error' | 'uncertain' }> {
    try {
      const cancelResult = await this.adapterClient.cancelRun(runId, {
        ownerId: this.options.ownerId,
        generation,
      });

      if (cancelResult.verifiedStopped) {
        await this.backendClient.finalize(runId, {
          ownerId: this.options.ownerId,
          generation,
          status: 'error',
          verifiedStopped: true,
          verificationMethod: cancelResult.verificationMethod ?? 'process_group_empty',
          errorCode: 'TIMEOUT',
          errorMessage: 'Task exceeded the 60-minute execution deadline',
        });
        this.scheduler.releaseRun(runId);
        this.retire(runId);
        return { ok: true, verifiedStopped: true, status: 'error' };
      }
    } catch {
      // Cancel failed or could not verify stop
    }

    try {
      await this.backendClient.markUncertain(runId, {
        ownerId: this.options.ownerId,
        generation,
        reason: 'Timeout: could not verify process tree stopped',
      });
    } catch {
      // Ignore
    }
    this.scheduler.releaseRun(runId);
    this.retire(runId);
    return { ok: false, verifiedStopped: false, status: 'uncertain' };
  }

  /**
   * Dispatches a claimed task to the adapter, handles delta coalescing, forwards events,
   * recovers from SSE disconnects without spawning second runs, and finalizes on stop.
   */
  async dispatchTask(params: {
    task: TaskRecord;
    claim: ClaimTaskResponse | { runId: string; generation: number; [key: string]: unknown };
    context: TaskContext;
    provider?: 'codex' | 'claude';
    scenario?: string;
    simulateLostAck?: boolean;
  }): Promise<DispatchResult> {
    const { runId, generation } = params.claim;
    const deadlineAt =
      'deadlineAt' in params.claim && typeof params.claim.deadlineAt === 'string'
        ? params.claim.deadlineAt
        : undefined;
    const provider = params.provider ?? 'codex';

    // Fresh isolated stream state for this attempt — never reuses a prior
    // attempt's cursor/delta/timer, even if a slot is reused for a different run.
    this.runStates.set(runId, freshStreamState(0));

    // 1. Backend claim strictly precedes adapter start.
    // Instruction is compiled from bounded context.
    const instruction = buildTaskInstruction(params.context);

    // 2. Start background heartbeat if configured
    const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? 0;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatAborted = false;

    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(async () => {
        try {
          await this.backendClient.heartbeat(runId, {
            ownerId: this.options.ownerId,
            generation,
          });
        } catch (err: unknown) {
          if (err instanceof BackendClientError && err.status === 409) {
            heartbeatAborted = true;
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
          }
        }
      }, heartbeatIntervalMs);
    }

    try {
      // 3. Mint managed MCP token and configure start payload
      let mcpConfig: { endpoint: string; accessToken: string } | undefined;
      try {
        const mcpTokenRes = await this.backendClient.mintManagedMcpToken(runId);
        mcpConfig = {
          endpoint: `${this.backendClient.getBaseUrl()}/mcp`,
          accessToken: mcpTokenRes.token,
        };
      } catch {
        // If MCP token minting fails or not supported, proceed without it
      }

      // 4. Start run on adapter (idempotent; returns existing snapshot if already started).
      const startPayload = {
        runId,
        taskId: params.task.id,
        provider,
        cwd: params.context.repository.canonicalPath,
        instruction,
        ownerId: this.options.ownerId,
        generation,
        mcp: mcpConfig,
        deadlineAt,
      };

      try {
        await this.adapterClient.startRun(
          startPayload,
          params.scenario ? { scenario: params.scenario } : undefined,
        );
      } catch (err: unknown) {
        // StartRun fault: adapter unreachable or error -> mark uncertain to prevent concurrent writer!
        await this.flushPendingDelta(runId);
        await this.backendClient.markUncertain(runId, {
          ownerId: this.options.ownerId,
          generation,
          reason: `Adapter startRun failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        this.scheduler.releaseRun(runId);
        this.retire(runId);
        return {
          runId,
          taskId: params.task.id,
          status: 'uncertain',
          lastSequence: 0,
          verifiedStopped: false,
        };
      }

      return await this.streamEventsToTermination({
        runId,
        taskId: params.task.id,
        generation,
        startAfter: 0,
        simulateLostAck: params.simulateLostAck,
        heartbeatAbortedRef: {
          get current() {
            return heartbeatAborted;
          },
        },
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }

  /**
   * Reads SSE events from adapter, handles delta coalescing, disconnect recovery,
   * detects terminal events, finalizes with verified stopped proof on completion,
   * and releases the scheduler lock. All mutable cursor/delta state lives in this
   * run's isolated `RunStreamState` entry — never touches another run's state.
   */
  private async streamEventsToTermination(params: {
    runId: string;
    taskId: string;
    generation: number;
    startAfter?: number;
    simulateLostAck?: boolean;
    heartbeatAbortedRef?: { current: boolean };
  }): Promise<DispatchResult> {
    const { runId, taskId, generation, startAfter = 0, simulateLostAck } = params;
    const state = this.stateFor(runId);
    let currentAfter = startAfter;
    state.lastAcknowledgedSequence = startAfter;
    state.pendingDelta = null;
    let isTerminal = false;
    let terminalStatus: 'done' | 'error' | 'cancelled' | 'hitl' | null = null;

    const handleIncomingEvent = async (event: EventEnvelope) => {
      if (event.type === 'message.delta') {
        // Delta event: coalesce consecutive deltas for the same messageId
        if (state.pendingDelta && state.pendingDelta.messageId === event.data.messageId) {
          state.pendingDelta.accumulatedDelta += event.data.delta;
          state.pendingDelta.lastSequence = event.sequence;
          state.pendingDelta.timestamp = event.timestamp;
        } else {
          // New message delta: flush existing pending delta first
          await this.flushPendingDelta(runId);
          state.pendingDelta = {
            runId,
            generation,
            messageId: event.data.messageId,
            accumulatedDelta: event.data.delta,
            lastSequence: event.sequence,
            timestamp: event.timestamp,
          };
        }

        // Start delta flush timer if not active
        if (!state.deltaTimer) {
          state.deltaTimer = setTimeout(() => {
            this.flushPendingDelta(runId).catch(() => {});
          }, this.options.deltaCoalesceMs ?? 20);
        }
      } else {
        // Control or persistent event:
        // Rule: deltas coalesce without delaying control events!
        // Immediately flush any pending coalesced delta first.
        await this.flushPendingDelta(runId);

        // Forward control event with retry
        const extraHeaders = simulateLostAck ? { 'x-simulate-lost-ack': 'true' } : undefined;

        await this.forwardWithRetry(runId, generation, [event], extraHeaders);
        state.lastAcknowledgedSequence = Math.max(state.lastAcknowledgedSequence, event.sequence);
        currentAfter = state.lastAcknowledgedSequence;

        // Terminal event detection
        if (event.type === 'completed') {
          isTerminal = true;
          terminalStatus = 'done';
        } else if (event.type === 'failed') {
          isTerminal = true;
          terminalStatus = 'error';
        } else if (event.type === 'cancelled') {
          isTerminal = true;
          terminalStatus = 'cancelled';
        } else if (event.type === 'input_required') {
          isTerminal = true;
          terminalStatus = 'hitl';
        }
      }
    };

    // SSE event stream reading with disconnect recovery loop.
    let disconnectRetries = 0;
    const maxDisconnectRetries = 5;

    while (
      !isTerminal &&
      !params.heartbeatAbortedRef?.current &&
      disconnectRetries < maxDisconnectRetries
    ) {
      const abortController = new AbortController();
      try {
        await this.adapterClient.streamEvents(runId, currentAfter, {
          signal: abortController.signal,
          onEvent: async (event) => {
            await handleIncomingEvent(event);
            if (isTerminal || params.heartbeatAbortedRef?.current) {
              abortController.abort();
            }
          },
        });
      } catch {
        // Stream ended, aborted, or connection dropped
      }

      if (isTerminal || params.heartbeatAbortedRef?.current) {
        break;
      }

      // Stream dropped before receiving terminal event: inspect adapter status
      disconnectRetries++;
      let runStatus: import('../contracts/run.ts').RunStatusResponse;
      try {
        runStatus = await this.adapterClient.getRunStatus(runId);
      } catch (err: unknown) {
        // Adapter crashed/lost state (404) or connection refused:
        // We cannot prove process stopped -> mark uncertain to quarantine lock!
        await this.flushPendingDelta(runId);
        await this.backendClient.markUncertain(runId, {
          ownerId: this.options.ownerId,
          generation,
          reason: `Adapter lost run state or crashed during streaming: ${err instanceof Error ? err.message : String(err)}`,
        });
        this.scheduler.releaseRun(runId);
        const lastSequence = state.lastAcknowledgedSequence;
        this.retire(runId);
        return {
          runId,
          taskId,
          status: 'uncertain',
          lastSequence,
          verifiedStopped: false,
        };
      }

      const adapterStatus = runStatus.processState.status;

      if (adapterStatus === 'done' || adapterStatus === 'error' || adapterStatus === 'cancelled') {
        isTerminal = true;
        terminalStatus = adapterStatus;
        break;
      }

      if (adapterStatus === 'hitl') {
        isTerminal = true;
        terminalStatus = 'hitl';
        break;
      }

      await new Promise((r) => setTimeout(r, 20));
    }

    // Ensure all pending deltas are flushed
    await this.flushPendingDelta(runId);

    // Finalization on terminal stop with verifiedStopped proof. The adapter
    // may report the terminal event slightly before it finishes recording
    // verifiedStoppedAt/verificationMethod on the run record (observed with
    // real Codex/Claude CLI exits under A12 live smoke testing) — poll
    // briefly for it rather than racing a single read, the same pattern
    // already used in resumeHitlTask below.
    let verifiedStopped = false;
    let verificationMethod: 'process_group_empty' | 'ps_fingerprint_absent' | undefined;

    if (terminalStatus === 'done' || terminalStatus === 'error' || terminalStatus === 'cancelled') {
      let finalStatus = await this.adapterClient.getRunStatus(runId);
      verifiedStopped = finalStatus.processState.verifiedStoppedAt !== null;
      // Bounded wait (6s): observed real Codex/Claude CLI exits can take over
      // a second between the terminal SSE event and the adapter recording
      // verifiedStoppedAt/verificationMethod on the run record.
      for (let i = 0; i < 60 && !verifiedStopped; i++) {
        await new Promise((r) => setTimeout(r, 100));
        finalStatus = await this.adapterClient.getRunStatus(runId);
        verifiedStopped = finalStatus.processState.verifiedStoppedAt !== null;
      }
      verificationMethod = finalStatus.processState.verificationMethod ?? undefined;

      if (!verifiedStopped) {
        // Never fabricate stop evidence: quarantine instead of finalizing
        // with an unproven status.
        await this.backendClient.markUncertain(runId, {
          ownerId: this.options.ownerId,
          generation,
          reason: `Terminal event (${terminalStatus}) reported but adapter never recorded verified stop proof`,
        });
        this.scheduler.releaseRun(runId);
        const lastSequence = state.lastAcknowledgedSequence;
        this.retire(runId);
        return {
          runId,
          taskId,
          status: 'uncertain',
          lastSequence,
          verifiedStopped: false,
        };
      }

      await this.backendClient.finalize(runId, {
        ownerId: this.options.ownerId,
        generation,
        status: terminalStatus,
        verifiedStopped,
        verificationMethod: verificationMethod ?? 'process_group_empty',
      });

      // Release lock in scheduler
      this.scheduler.releaseRun(runId);
    }

    const lastSequence = state.lastAcknowledgedSequence;
    // Terminal (done/error/cancelled): this attempt's monitoring is over —
    // retire its isolated state so slot reuse starts clean. HITL keeps its
    // state alive (resumeHitlTask continues the SAME run's cursor).
    if (terminalStatus !== 'hitl') {
      this.retire(runId);
    }

    return {
      runId,
      taskId,
      status: terminalStatus ?? 'uncertain',
      lastSequence,
      verifiedStopped,
      verificationMethod,
    };
  }

  /**
   * Resumes a paused HITL run after user input is provided.
   * Handles:
   * 1. Retained adapter process resumption via provideInput.
   * 2. Stop-and-resume model using declared provider capabilities (resume: true via sessionId vs resume: false via fresh turn with reply in context).
   * 3. Process-stop verification before launching next turn if stop-and-resume.
   */
  async resumeHitlTask(params: ResumeHitlParams): Promise<DispatchResult> {
    const { task, claim, context, response, requestId } = params;
    const { runId, generation } = claim;
    const provider = params.provider ?? 'codex';
    const deadlineAt =
      'deadlineAt' in claim && typeof claim.deadlineAt === 'string' ? claim.deadlineAt : undefined;

    // 1. Inspect adapter status
    const runStatus = await this.adapterClient.getRunStatus(runId);
    const capabilities = await this.adapterClient.getCapabilities();
    const provCap = capabilities.providers[provider];

    // Case A: Retained active process waiting in hitl status
    if (runStatus.processState.status === 'hitl') {
      await this.adapterClient.provideInput(runId, {
        ownerId: this.options.ownerId,
        generation,
        requestId,
        response,
      });

      return this.streamEventsToTermination({
        runId,
        taskId: task.id,
        generation,
        startAfter: this.getLastAcknowledgedSequence(runId),
      });
    }

    // Case B: Stop-and-resume model (process stopped upon input_required)
    // First, verify process stopped before launching next turn
    let verifiedStopped = runStatus.processState.verifiedStoppedAt !== null;
    if (!verifiedStopped) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const checkStatus = await this.adapterClient.getRunStatus(runId);
        if (checkStatus.processState.verifiedStoppedAt !== null) {
          verifiedStopped = true;
          break;
        }
      }
    }

    if (!verifiedStopped) {
      // Prior process has not stopped: cannot safely launch second writer!
      await this.backendClient.markUncertain(runId, {
        ownerId: this.options.ownerId,
        generation,
        reason: 'Cannot resume HITL: prior process has not verified stopped',
      });
      this.scheduler.releaseRun(runId);
      const lastSequence = this.getLastAcknowledgedSequence(runId);
      this.retire(runId);
      return {
        runId,
        taskId: task.id,
        status: 'uncertain',
        lastSequence,
        verifiedStopped: false,
      };
    }

    // Process is verified stopped. Check declared provider capabilities:
    if (provCap?.resume) {
      // Provider supports session resume (e.g. Claude Code CLI)
      const resumeInstruction = `User reply: ${response}`;
      await this.adapterClient.startRun(
        {
          runId,
          taskId: task.id,
          provider,
          cwd: context.repository.canonicalPath,
          instruction: resumeInstruction,
          ownerId: this.options.ownerId,
          generation,
          sessionId: params.sessionId,
          deadlineAt,
        },
        params.scenario ? { scenario: params.scenario } : undefined,
      );

      return this.streamEventsToTermination({
        runId,
        taskId: task.id,
        generation,
        startAfter: this.getLastAcknowledgedSequence(runId),
      });
    }

    // Provider does not support session resume (e.g. Codex exec baseline)
    // Fallback: fresh turn with updated conversation context containing question and answer
    const instruction = buildTaskInstruction(context);
    await this.adapterClient.startRun(
      {
        runId,
        taskId: task.id,
        provider,
        cwd: context.repository.canonicalPath,
        instruction,
        ownerId: this.options.ownerId,
        generation,
        deadlineAt,
      },
      params.scenario ? { scenario: params.scenario } : undefined,
    );

    return this.streamEventsToTermination({
      runId,
      taskId: task.id,
      generation,
      startAfter: this.getLastAcknowledgedSequence(runId),
    });
  }
}
