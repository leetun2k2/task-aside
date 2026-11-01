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
import { mkdirSync } from 'node:fs';
import { type EventEnvelope, PERSISTENT_EVENT_TYPES } from '../contracts/event.ts';
import {
  INTAKE_DEADLINE_MS,
  IntakeResultSchema,
  ROUTING_INSTRUCTION_VERSION,
} from '../contracts/intake.ts';
import type { ClaimTaskResponse } from '../contracts/run.ts';
import type { Provider } from '../contracts/task.ts';
import { buildIntakeInstruction } from './instruction-builder.ts';
import {
  type AdapterClient,
  AdapterClientError,
  type BackendClient,
  BackendClientError,
} from './client.ts';
import {
  EventForwarder,
  type PendingDelta,
  type RunStreamState,
  freshStreamState,
} from './event-forwarder.ts';
import { buildTaskInstruction } from './instruction-builder.ts';
import type { TaskScheduler } from './scheduler.ts';
import type {
  DispatchResult,
  DispatcherOptions,
  ResumeHitlParams,
  TaskContext,
  TaskRecord,
} from './types.ts';

export { EventForwarder, type PendingDelta, type RunStreamState, freshStreamState };

export interface DispatchTaskParams {
  task: TaskRecord;
  claim: ClaimTaskResponse | { runId: string; generation: number; [key: string]: unknown };
  context: TaskContext;
  provider?: Provider;
  scenario?: string; // For testing fake adapter scenarios
  simulateLostAck?: boolean;
}

export class RunDispatcher {
  private backendClient: BackendClient;
  private adapterClient: AdapterClient;
  private scheduler: TaskScheduler;
  private options: DispatcherOptions;
  private forwarder: EventForwarder;

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
    this.forwarder = new EventForwarder(backendClient, options);
  }

  private stateFor(runId: string): RunStreamState {
    return this.forwarder.stateFor(runId);
  }

  getLastAcknowledgedSequence(runId: string): number {
    return this.forwarder.getLastAcknowledgedSequence(runId);
  }

  getForwardedEvents(runId: string): EventEnvelope[] {
    return this.forwarder.getForwardedEvents(runId);
  }

  /** Retires a run's stream state — call once its monitoring has definitely
   * ended (terminal finalize, uncertain, or resume handed off) so slots don't
   * leak timers/memory across reuse. */
  private retire(runId: string): void {
    this.forwarder.retire(runId);
  }

  /**
   * Flushes any pending coalesced delta immediately to the backend, for ONE
   * run's isolated state.
   */
  async flushPendingDelta(runId: string): Promise<void> {
    return this.forwarder.flushPendingDelta(runId);
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
    return this.forwarder.forwardWithRetry(runId, generation, events, headers);
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
    provider?: Provider;
    scenario?: string;
    simulateLostAck?: boolean;
  }): Promise<DispatchResult> {
    const { runId, generation } = params.claim;
    const deadlineAt =
      'deadlineAt' in params.claim && typeof params.claim.deadlineAt === 'string'
        ? params.claim.deadlineAt
        : undefined;
    const provider = params.provider ?? params.context.repository?.defaultProvider ?? 'claude';
    const repository = params.context.repository;
    if (!repository) {
      throw new Error(
        `dispatchTask requires a resolved repository (task ${params.task.id} is still stage 'intake')`,
      );
    }

    // Fresh isolated stream state for this attempt — never reuses a prior
    // attempt's cursor/delta/timer, even if a slot is reused for a different run.
    this.forwarder.initRun(runId, 0);

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
      const writeRoots = (params.claim as { writeRoots?: string[] }).writeRoots ?? [
        repository.canonicalPath,
      ];
      const startPayload = {
        protocolVersion: 'v2' as const,
        runId,
        taskId: params.task.id,
        purpose: 'implementation' as const,
        provider,
        cwd: repository.canonicalPath,
        writeRoots,
        instruction,
        ownerId: this.options.ownerId,
        generation,
        runFence: (params.claim as { runFence?: number }).runFence ?? generation,
        lockGenerations: (params.claim as { lockGenerations?: Record<string, number> })
          .lockGenerations,
        mcp: mcpConfig,
        deadlineAt: (params.claim as { deadlineAt?: string }).deadlineAt ?? deadlineAt,
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
    purpose?: 'intake' | 'implementation';
  }): Promise<DispatchResult> {
    const { runId, taskId, generation, startAfter = 0, simulateLostAck } = params;
    const state = this.forwarder.initRun(runId, startAfter);
    let currentAfter = startAfter;
    let isTerminal = false;
    let terminalStatus: 'done' | 'error' | 'cancelled' | 'hitl' | null = null;

    const handleIncomingEvent = async (event: EventEnvelope) => {
      const ingestResult = await this.forwarder.ingestEvent({
        runId,
        generation,
        event,
        simulateLostAck,
      });
      currentAfter = ingestResult.sequence;
      if (ingestResult.isTerminal) {
        isTerminal = true;
        terminalStatus = ingestResult.terminalStatus;
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

      if (params.purpose === 'intake') {
        // No generic finalize: committing the validated Intake result (or
        // failing it) IS this attempt's finalization (01-contracts-and-
        // lifecycle.md "atomically commit resolution, finish the Intake
        // run, revoke its token and release its slot").
        await this.commitOrFailIntake({
          runId,
          generation,
          terminalStatus,
          verificationMethod: verificationMethod ?? 'process_group_empty',
        });
      } else {
        await this.backendClient.finalize(runId, {
          ownerId: this.options.ownerId,
          generation,
          status: terminalStatus,
          verifiedStopped,
          verificationMethod: verificationMethod ?? 'process_group_empty',
        });
      }

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
   * Extracts the ONE final structured JSON object an Intake attempt must
   * produce as its entire final message — never parsed from Markdown
   * fences, raw logs, or arbitrary braces in prose (01-contracts-and-
   * lifecycle.md "The JSON is one final object; do not parse it from
   * Markdown fences, raw logs, or arbitrary braces in prose."). Only a
   * `message.completed` event whose ENTIRE trimmed content parses as one
   * JSON object qualifies.
   */
  private extractIntakeResult(runId: string): unknown {
    const events = this.forwarder.getForwardedEvents(runId);
    const completed = [...events].reverse().find((e) => e.type === 'message.completed');
    if (!completed) {
      return undefined;
    }
    const content = String((completed.data as { content?: unknown }).content ?? '').trim();
    try {
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  /** After verified stop, validate and commit (or fail) the Intake attempt. */
  private async commitOrFailIntake(params: {
    runId: string;
    generation: number;
    terminalStatus: 'done' | 'error' | 'cancelled';
    verificationMethod: 'process_group_empty' | 'ps_fingerprint_absent';
  }): Promise<void> {
    const { runId, generation, terminalStatus, verificationMethod } = params;

    if (terminalStatus !== 'done') {
      await this.backendClient.failIntake(runId, {
        ownerId: this.options.ownerId,
        generation,
        verifiedStopped: true,
        verificationMethod,
        reason: `Intake attempt ended with status '${terminalStatus}' before producing a result`,
      });
      return;
    }

    let raw: unknown = undefined;
    try {
      const outcome = await this.adapterClient.getRunOutcome(runId);
      if (outcome?.intakeResult) {
        raw = outcome.intakeResult;
      }
    } catch {
      // fallback to forwarded events
    }
    if (!raw) {
      raw = this.extractIntakeResult(runId);
    }
    const parsed = IntakeResultSchema.safeParse(raw);
    if (!parsed.success) {
      await this.backendClient.failIntake(runId, {
        ownerId: this.options.ownerId,
        generation,
        verifiedStopped: true,
        verificationMethod,
        reason: 'Intake did not return one valid final JSON result matching the schema',
      });
      return;
    }

    try {
      await this.backendClient.commitIntakeResult(runId, {
        ownerId: this.options.ownerId,
        generation,
        verifiedStopped: true,
        verificationMethod,
        result: parsed.data,
        routingInstructionVersion: ROUTING_INSTRUCTION_VERSION,
      });
    } catch (err) {
      // The backend's own independent authorization/persistence checks
      // (01-contracts-and-lifecycle.md "backend independently validates
      // persistent constraints and authorization") can still reject a
      // schema-valid result (unknown repo id, revoked authorization, wrong
      // parent, ...) — that is an Intake failure too, not an engine crash.
      await this.backendClient
        .failIntake(runId, {
          ownerId: this.options.ownerId,
          generation,
          verifiedStopped: true,
          verificationMethod,
          reason: `Backend rejected the Intake result: ${err instanceof Error ? err.message : String(err)}`,
        })
        .catch(() => {});
    }
  }

  /**
   * Dispatches an Intake attempt (specs/2026-10-25-message-intake/01-
   * contracts-and-lifecycle.md "Intake attempt"): scratch cwd, no repo
   * locks, the versioned routing instruction, and a managed MCP token
   * restricted to the Intake tool profile (create_task/request_input only —
   * no code-writing tools, no ambient MCP servers). Reuses the same
   * stream/disconnect/verified-stop machinery as an implementation
   * dispatch; only the terminal commit step differs (commitOrFailIntake).
   */
  async dispatchIntake(params: {
    task: TaskRecord;
    claim: ClaimTaskResponse | { runId: string; generation: number; [key: string]: unknown };
    context: TaskContext;
    scratchCwd: string;
    provider?: Provider;
    scenario?: string;
  }): Promise<DispatchResult> {
    const { runId, generation } = params.claim;
    const provider = params.provider ?? 'claude';

    this.forwarder.initRun(runId, 0);

    // The adapter only checks that `cwd` exists (it does not itself enforce
    // a registered-repo allowlist); the engine is responsible for ensuring
    // this app-owned scratch directory is there before dispatch, since it
    // is never a registered working tree Intake could have inherited.
    mkdirSync(params.scratchCwd, { recursive: true });

    const instruction = buildIntakeInstruction(params.context);

    let mcpConfig: { endpoint: string; accessToken: string };
    try {
      const mcpTokenRes = await this.backendClient.mintManagedMcpToken(runId, {
        toolProfile: 'intake',
      });
      mcpConfig = {
        endpoint: `${this.backendClient.getBaseUrl()}/mcp`,
        accessToken: mcpTokenRes.token,
      };
    } catch (err: unknown) {
      await this.backendClient.failIntake(runId, {
        ownerId: this.options.ownerId,
        generation,
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
        reason: `Failed to mint managed MCP token for Intake: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.scheduler.releaseRun(runId);
      this.retire(runId);
      return {
        runId,
        taskId: params.task.id,
        status: 'error',
        lastSequence: 0,
        verifiedStopped: true,
      };
    }

    const deadlineAt =
      (params.claim as { deadlineAt?: string }).deadlineAt ??
      new Date(Date.now() + INTAKE_DEADLINE_MS).toISOString();

    try {
      await this.adapterClient.startRun(
        {
          protocolVersion: 'v2',
          runId,
          taskId: params.task.id,
          purpose: 'intake',
          provider,
          cwd: params.scratchCwd,
          writeRoots: [],
          instruction,
          ownerId: this.options.ownerId,
          generation,
          runFence: (params.claim as { runFence?: number }).runFence ?? generation,
          lockGenerations: {},
          mcp: mcpConfig,
          deadlineAt,
        },
        params.scenario ? { scenario: params.scenario } : undefined,
      );
    } catch (err: unknown) {
      await this.flushPendingDelta(runId);
      await this.backendClient.markUncertain(runId, {
        ownerId: this.options.ownerId,
        generation,
        reason: `Adapter startRun failed (intake): ${err instanceof Error ? err.message : String(err)}`,
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

    return this.streamEventsToTermination({
      runId,
      taskId: params.task.id,
      generation,
      startAfter: 0,
      purpose: 'intake',
    });
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
    const provider = params.provider ?? params.context.repository?.defaultProvider ?? 'claude';
    const deadlineAt =
      'deadlineAt' in claim && typeof claim.deadlineAt === 'string' ? claim.deadlineAt : undefined;
    const repository = context.repository;
    if (!repository) {
      throw new Error(`resumeHitlTask requires a resolved repository (task ${task.id})`);
    }

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

    const writeRoots = (claim as { writeRoots?: string[] }).writeRoots ?? [
      repository.canonicalPath,
    ];
    const runFence = (claim as { runFence?: number }).runFence ?? generation;
    const lockGenerations = (claim as { lockGenerations?: Record<string, number> }).lockGenerations;

    // Process is verified stopped. Check declared provider capabilities:
    if (provCap?.resume) {
      // Provider supports session resume (e.g. Claude Code CLI)
      const resumeInstruction = `User reply: ${response}`;
      await this.adapterClient.startRun(
        {
          protocolVersion: 'v2',
          runId,
          taskId: task.id,
          purpose: 'implementation',
          provider,
          cwd: repository.canonicalPath,
          writeRoots,
          instruction: resumeInstruction,
          ownerId: this.options.ownerId,
          generation,
          runFence,
          lockGenerations,
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
        protocolVersion: 'v2',
        runId,
        taskId: task.id,
        purpose: 'implementation',
        provider,
        cwd: repository.canonicalPath,
        writeRoots,
        instruction,
        ownerId: this.options.ownerId,
        generation,
        runFence,
        lockGenerations,
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
