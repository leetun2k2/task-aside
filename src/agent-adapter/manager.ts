// Adapter run manager (SPECIFICATION.md §2, §3; ARCHITECTURE.md §6; TASKS.md T16, T17).
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CancelRunRequest,
  type EventEnvelope,
  type IntakeResult,
  IntakeResultSchema,
  type ProvideInputRequest,
  type Provider,
  type RunOutcome,
  type RunStatusResponse,
  type StartRunRequest,
} from '../contracts/index.ts';
import { getLogsDir } from '../supervisor/paths.ts';
import { AgyDriver } from './drivers/agy.ts';
import { ClaudeDriver } from './drivers/claude.ts';
import { CodexDriver } from './drivers/codex.ts';
import type { AgentDriver, DriverCallbacks, DriverCancelResult } from './drivers/types.ts';
import {
  AdapterError,
  NotFoundError,
  RequestAlreadyResolvedError,
  StaleGenerationError,
  ValidationError,
} from './errors.ts';
import { MAX_EVENT_BUFFER, RunEventStream } from './event-stream.ts';
import { DEFAULT_MAX_LOG_SIZE_BYTES, formatRunLogLine, writeRunLog } from './logging.ts';
import {
  resetLaunchProof,
  stampVerifiedStop,
  verifyNaturalStop,
} from './services/run-stop-service.ts';
import {
  type LaunchRecord,
  computePayloadHash,
  getActiveLaunch,
  loadJournal,
  recordLaunchStarted,
  recordLaunchStopped,
} from './state/launch-journal.ts';
import type { AdapterRun, FakeScenario } from './types.ts';

/**
 * Deterministic-test helper only (specs/2026-10-25-message-intake): the
 * fake 'success' scenario has no real model to ask, so for an Intake
 * dispatch (recognizable by its scratch cwd — see supervisor/paths.ts
 * getIntakeScratchDir) it must still produce one schema-valid final JSON
 * result instead of generic prose, or every deterministic check that
 * creates a task and expects it to reach real implementation dispatch
 * would hang at the Intake gate. It parses the rendered routing
 * instruction (src/execution-engine/instruction-builder.ts
 * buildIntakeInstruction) for the submitted title/priority overrides and
 * the first authorized repository id, and always resolves `action:
 * 'implement'` with that single repo — multi-repo/delegate/request_input
 * fake-success behavior is not synthesized here. This never runs against a
 * real provider driver.
 */
function synthesizeFakeIntakeResultContent(instruction: string): string | null {
  const catalogBlock = instruction.match(/## Authorized repository catalog\n([\s\S]*?)\n\n/);
  const allAuthorizedIds = catalogBlock
    ? [...catalogBlock[1].matchAll(/- `([^`]+)`/g)].map((m) => m[1])
    : [];
  if (allAuthorizedIds.length === 0) {
    return null;
  }
  // Prefer the first submitted repo hint that is also authorized, so two
  // concurrently-dispatched Intake attempts with different hints resolve to
  // different repos instead of colliding on whichever repo happens to be
  // listed first in the catalog.
  const hintsMatch = instruction.match(/\*\*Repo hints\*\*: (.+)/);
  const hintedIds =
    hintsMatch && !hintsMatch[1].startsWith('*(none')
      ? hintsMatch[1].split(',').map((s) => s.trim())
      : [];
  const repoId = hintedIds.find((id) => allAuthorizedIds.includes(id)) ?? allAuthorizedIds[0];

  const titleMatch = instruction.match(/\*\*Submitted title\*\*: (.+)/);
  const title =
    titleMatch && !titleMatch[1].startsWith('*(none')
      ? titleMatch[1].trim()
      : 'Fake adapter resolved task';

  const priorityMatch = instruction.match(/\*\*Submitted priority\*\*: (P[0-3])\b/);
  const priority = priorityMatch ? priorityMatch[1] : 'P2';

  return JSON.stringify({
    version: 1,
    action: 'implement',
    title,
    repoIds: [repoId],
    priority,
    executionProvider: 'claude',
    goal: 'Fake adapter synthesized this result for deterministic testing.',
  });
}

export class AdapterRunManager {
  private runs = new Map<string, AdapterRun>();
  private drivers = new Map<Provider, AgentDriver>();
  private maxLogSizeBytes: number;
  private journalPath: string | undefined;
  // Launches recorded as 'active' in the journal that this process instance
  // never spawned itself (left over from a crash/restart). A respawn for the
  // same runId is refused until the launch is resolved (verified stopped via
  // cancelRun, which clears the journal entry).
  private unresolvedLaunches: Map<string, LaunchRecord>;

  constructor(options?: {
    codexDriver?: AgentDriver;
    claudeDriver?: AgentDriver;
    agyDriver?: AgentDriver;
    maxLogSizeBytes?: number;
    journalPath?: string;
  }) {
    this.drivers.set('codex', options?.codexDriver ?? new CodexDriver());
    this.drivers.set('claude', options?.claudeDriver ?? new ClaudeDriver());
    this.drivers.set('agy', options?.agyDriver ?? new AgyDriver());
    this.maxLogSizeBytes = options?.maxLogSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
    this.journalPath = options?.journalPath;
    this.unresolvedLaunches = new Map(
      loadJournal(this.journalPath)
        .filter((l) => l.status === 'active')
        .map((l) => [l.runId, l]),
    );
  }

  setDriver(provider: Provider, driver: AgentDriver): void {
    this.drivers.set(provider, driver);
  }

  startRun(
    req: StartRunRequest,
    options?: { scenario?: FakeScenario },
  ): { runId: string; started: boolean; existing?: boolean } {
    const payloadHash = computePayloadHash({
      provider: req.provider,
      cwd: req.cwd,
      writeRoots: req.writeRoots ?? [],
      purpose: req.purpose ?? 'implementation',
      instructionLength: req.instruction.length,
    });

    const existing = this.runs.get(req.runId);
    if (existing) {
      if (existing.ownerId !== req.ownerId || existing.generation !== req.generation) {
        throw new StaleGenerationError(
          `Run ${req.runId} exists with owner ${existing.ownerId} and generation ${existing.generation}`,
        );
      }
      const activeLaunch = getActiveLaunch(req.runId, this.journalPath);
      if (activeLaunch && activeLaunch.payloadHash !== payloadHash) {
        throw new AdapterError(
          'VALIDATION_ERROR',
          `Repeated start for run ${req.runId} conflicts with the in-flight launch's payload`,
        );
      }
      // Repeated start never spawns twice: return existing run info idempotently
      return { runId: req.runId, started: true, existing: true };
    }

    if (this.unresolvedLaunches.has(req.runId)) {
      throw new AdapterError(
        'RUN_UNCERTAIN',
        `A prior launch for run ${req.runId} was never confirmed stopped; resolve it before starting a new one`,
      );
    }

    if (!existsSync(req.cwd)) {
      throw new ValidationError(`Working directory cwd "${req.cwd}" does not exist`);
    }

    // Codex baseline driver does not support session resume (TASKS.md T17)
    if (req.provider === 'codex' && req.sessionId && !options?.scenario) {
      throw new AdapterError(
        'VALIDATION_ERROR',
        'Codex driver does not support session resume in exec baseline',
      );
    }

    if (req.purpose === 'intake' && req.provider === 'agy' && !options?.scenario) {
      throw new AdapterError(
        'VALIDATION_ERROR',
        'agy provider does not support Intake tool isolation profile',
      );
    }

    if (req.writeRoots && req.writeRoots.length > 1 && !options?.scenario) {
      if (req.provider !== 'codex' && req.provider !== 'claude') {
        throw new AdapterError(
          'VALIDATION_ERROR',
          `Provider ${req.provider} does not support multi-repo write roots`,
        );
      }
    }

    const runsLogDir = join(getLogsDir(), 'runs');
    try {
      mkdirSync(runsLogDir, { recursive: true });
    } catch {
      // directory exists or will be created
    }
    const logPath = join(runsLogDir, `${req.runId}.log`);
    writeRunLog(
      logPath,
      formatRunLogLine({
        runId: req.runId,
        type: 'RUN_STARTED',
        data: {
          provider: req.provider,
          cwd: req.cwd,
          taskId: req.taskId,
          ownerId: req.ownerId,
          generation: req.generation,
          sessionId: req.sessionId,
          mcp: req.mcp,
        },
      }),
      this.maxLogSizeBytes,
    );

    const scenario = options?.scenario;
    const purpose = req.purpose ?? 'implementation';
    const writeRoots = req.writeRoots ?? [];
    const runFence = req.runFence ?? req.generation;

    const stream = new RunEventStream(req.runId, MAX_EVENT_BUFFER);
    const run: AdapterRun = {
      runId: req.runId,
      taskId: req.taskId,
      purpose,
      provider: req.provider,
      cwd: req.cwd,
      writeRoots,
      instruction: req.instruction,
      ownerId: req.ownerId,
      generation: req.generation,
      runFence,
      lockGenerations: req.lockGenerations,
      sessionId: req.sessionId,
      mcp: req.mcp,
      scenario,
      status: 'running',
      events: stream.bufferRef,
      lastSequence: 0,
      pendingRequestId: null,
      verifiedStoppedAt: null,
      verificationMethod: null,
      exitCode: null,
      createdAt: new Date().toISOString(),
      subscribers: stream.subscribers,
      onEndSubscribers: stream.onEndSubscribers,
      logPath,
      deadlineAt: req.deadlineAt,
      stream,
    };

    if (req.deadlineAt) {
      const ms = new Date(req.deadlineAt).getTime() - Date.now();
      run.deadlineTimer = setTimeout(
        () => {
          this.handleDeadlineTimeout(run);
        },
        Math.max(0, ms),
      );
    }

    this.runs.set(req.runId, run);

    if (scenario) {
      this.executeScenario(run, scenario);
    } else {
      const driver = this.drivers.get(req.provider);
      if (driver) {
        Promise.resolve()
          .then(() => driver.start(run, this.bindDriverCallbacks(run, payloadHash)))
          .catch((err: unknown) => this.handleDriverError(run, err));
      } else {
        this.executeScenario(run, 'success');
      }
    }

    return { runId: req.runId, started: true };
  }

  private handleDriverEvent(run: AdapterRun, event: EventEnvelope): void {
    this.emitEvent(run, event);
  }

  private async handleDriverEnd(run: AdapterRun): Promise<void> {
    this.clearDeadlineTimer(run);
    if (run.status === 'running') {
      // Fallback for drivers (agy) that don't stamp proof themselves: never
      // assume the process group is empty just because onEnd fired.
      const result = await verifyNaturalStop(run.processGroupPid);
      stampVerifiedStop(run, result);
      run.status = result.verifiedStopped ? 'done' : 'uncertain';
      run.exitCode = result.verifiedStopped ? 0 : null;
    }
    if (run.verifiedStoppedAt) {
      recordLaunchStopped(run.runId, this.journalPath);
    }
    if (!run.outcome) {
      let intakeResult: IntakeResult | undefined;
      if (run.purpose === 'intake') {
        const lastMsg = [...run.events].reverse().find((e) => e.type === 'message.completed');
        if (lastMsg && typeof (lastMsg.data as { content?: string })?.content === 'string') {
          const content = (lastMsg.data as { content: string }).content.trim();
          try {
            intakeResult = IntakeResultSchema.parse(JSON.parse(content));
          } catch {}
        }
      }
      run.outcome = {
        runId: run.runId,
        terminalStatus: run.status,
        intakeResult,
        summary:
          run.status === 'done'
            ? run.purpose === 'intake'
              ? 'Intake completed'
              : 'Task completed'
            : 'Run finished',
        verifiedStopped: Boolean(run.verifiedStoppedAt),
        verificationMethod: run.verificationMethod,
      };
    }
    this.notifyRunEnded(run);
  }

  private async handleDriverError(run: AdapterRun, err: unknown): Promise<void> {
    this.clearDeadlineTimer(run);
    // start() can throw before any process was ever spawned (no pid yet) or
    // after (pid assigned, then a later synchronous failure) — only the
    // latter needs a real group-emptiness check.
    const result = await verifyNaturalStop(run.processGroupPid);
    stampVerifiedStop(run, result);
    run.status = result.verifiedStopped ? 'error' : 'uncertain';
    run.exitCode = result.verifiedStopped ? 1 : null;
    if (run.verifiedStoppedAt) {
      recordLaunchStopped(run.runId, this.journalPath);
    }
    const seq = run.lastSequence + 1;
    this.emitEvent(run, {
      runId: run.runId,
      sequence: seq,
      type: 'failed',
      timestamp: new Date().toISOString(),
      data: {
        errorCode: 'AGENT_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    if (!run.outcome) {
      run.outcome = {
        runId: run.runId,
        terminalStatus: run.status,
        summary: err instanceof Error ? err.message : String(err),
        verifiedStopped: Boolean(run.verifiedStoppedAt),
        verificationMethod: run.verificationMethod,
      };
    }
    this.notifyRunEnded(run);
  }

  private handleDriverSessionId(run: AdapterRun, sid: string): void {
    run.sessionId = sid;
  }

  private bindDriverCallbacks(run: AdapterRun, payloadHash: string): DriverCallbacks {
    return {
      onEvent: (event: EventEnvelope) => this.handleDriverEvent(run, event),
      onEnd: () => {
        void this.handleDriverEnd(run);
      },
      onSessionId: (sid: string) => this.handleDriverSessionId(run, sid),
      onProcessGroupPid: (pgid: number) => {
        resetLaunchProof(run);
        this.unresolvedLaunches.delete(run.runId);
        recordLaunchStarted(
          {
            launchId: randomUUID(),
            runId: run.runId,
            provider: run.provider,
            payloadHash,
            pgid,
            startedAt: new Date().toISOString(),
            status: 'active',
          },
          this.journalPath,
        );
      },
    };
  }

  getRun(runId: string): AdapterRun | undefined {
    return this.runs.get(runId);
  }

  getRunStatus(runId: string): RunStatusResponse {
    const run = this.runs.get(runId);
    if (!run) {
      throw new NotFoundError(`Run ${runId} not found`);
    }

    return {
      runId: run.runId,
      processState: {
        status: run.status,
        verifiedStoppedAt: run.verifiedStoppedAt,
        verificationMethod: run.verificationMethod,
        exitCode: run.exitCode,
      },
    };
  }

  subscribeEvents(
    runId: string,
    after: number,
    onEvent: (event: EventEnvelope) => void,
    onEnd: () => void,
  ): () => void {
    const run = this.runs.get(runId);
    if (!run) {
      throw new NotFoundError(`Run ${runId} not found`);
    }

    const isTerminal =
      run.status === 'done' || run.status === 'error' || run.status === 'cancelled';

    let unsubscribe: () => void;
    if (run.stream) {
      unsubscribe = run.stream.subscribe({
        after,
        onEvent,
        onEnd,
        isTerminal,
      });
    } else {
      // Replay past events after specified sequence
      for (const event of run.events) {
        if (event.sequence > after) {
          onEvent(event);
        }
      }
      if (isTerminal) {
        onEnd();
        return () => {};
      }
      run.subscribers.add(onEvent);
      run.onEndSubscribers.add(onEnd);
      unsubscribe = () => {
        run.subscribers.delete(onEvent);
        run.onEndSubscribers.delete(onEnd);
      };
    }

    if (run.scenario === 'disconnect') {
      setTimeout(() => {
        onEnd();
      }, 15);
    }

    return unsubscribe;
  }

  provideInput(runId: string, req: ProvideInputRequest): { ok: boolean } {
    const run = this.runs.get(runId);
    if (!run) {
      throw new NotFoundError(`Run ${runId} not found`);
    }

    if (req.ownerId !== run.ownerId || req.generation !== run.generation) {
      throw new StaleGenerationError(
        `Owner or generation mismatch: got owner=${req.ownerId} gen=${req.generation}, expected owner=${run.ownerId} gen=${run.generation}`,
      );
    }

    // Codex driver does not support interactive input in exec baseline (TASKS.md T17)
    if (run.provider === 'codex' && !run.scenario) {
      throw new AdapterError(
        'INVALID_TRANSITION',
        'Codex driver does not support interactive input in exec baseline',
      );
    }
    // Claude print-mode driver does not support interactive input mid-process (TASKS.md T18)
    if (run.provider === 'claude' && !run.scenario) {
      throw new AdapterError(
        'INVALID_TRANSITION',
        'Claude print-mode driver does not support interactive mid-process input; use cross-process resume with sessionId',
      );
    }

    if (run.status !== 'hitl') {
      throw new RequestAlreadyResolvedError(
        `Run ${runId} is in status ${run.status}, not awaiting input`,
      );
    }

    if (req.requestId && run.pendingRequestId && req.requestId !== run.pendingRequestId) {
      throw new RequestAlreadyResolvedError(
        `Request ID mismatch: got ${req.requestId}, expected ${run.pendingRequestId}`,
      );
    }

    run.pendingRequestId = null;
    run.status = 'running';

    // Resume execution with user response
    setTimeout(() => {
      const seq1 = run.lastSequence + 1;
      this.emitEvent(run, {
        runId: run.runId,
        sequence: seq1,
        type: 'message.completed',
        timestamp: new Date().toISOString(),
        data: {
          messageId: `msg_${seq1}`,
          content: `Resuming execution with provided input: ${req.response}`,
        },
      });

      const seq2 = run.lastSequence + 1;
      this.emitEvent(run, {
        runId: run.runId,
        sequence: seq2,
        type: 'completed',
        timestamp: new Date().toISOString(),
        data: {
          summary: 'Task completed successfully after input',
        },
      });

      run.status = 'done';
      this.clearDeadlineTimer(run);
      run.verifiedStoppedAt = new Date().toISOString();
      run.verificationMethod = 'process_group_empty';
      run.exitCode = 0;

      this.notifyRunEnded(run);
    }, 5);

    return { ok: true };
  }

  async cancelRun(
    runId: string,
    req: CancelRunRequest = {},
  ): Promise<{
    runId: string;
    verifiedStopped: boolean;
    verificationMethod: import('../contracts/index.ts').VerificationMethod;
  }> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new NotFoundError(`Run ${runId} not found`);
    }

    if (req.ownerId && req.ownerId !== run.ownerId) {
      throw new StaleGenerationError(`Owner mismatch: got ${req.ownerId}, expected ${run.ownerId}`);
    }
    if (req.generation !== undefined && req.generation !== run.generation) {
      throw new StaleGenerationError(
        `Generation mismatch: got ${req.generation}, expected ${run.generation}`,
      );
    }

    this.clearDeadlineTimer(run);
    if (run.status === 'cancelled' || run.status === 'done' || run.status === 'error') {
      return {
        runId: run.runId,
        verifiedStopped: Boolean(run.verifiedStoppedAt),
        verificationMethod: run.verificationMethod ?? 'process_group_empty',
      };
    }

    const driver = this.drivers.get(run.provider);
    if (!run.scenario && driver) {
      const cancelRes = await driver.cancel(run);
      stampVerifiedStop(run, cancelRes);
      run.status = cancelRes.verifiedStopped ? 'cancelled' : 'uncertain';
      if (cancelRes.verifiedStopped) {
        recordLaunchStopped(run.runId, this.journalPath);
      }
      return {
        runId: run.runId,
        verifiedStopped: cancelRes.verifiedStopped,
        verificationMethod: cancelRes.verificationMethod,
      };
    }

    run.status = 'cancelled';
    run.verifiedStoppedAt = new Date().toISOString();
    run.verificationMethod = 'process_group_empty';
    run.exitCode = 143;

    const cancelledEvent: EventEnvelope = {
      runId: run.runId,
      sequence: run.lastSequence + 1,
      type: 'cancelled',
      timestamp: new Date().toISOString(),
      data: {},
    };
    this.emitEvent(run, cancelledEvent);
    this.notifyRunEnded(run);

    return {
      runId: run.runId,
      verifiedStopped: true,
      verificationMethod: 'process_group_empty',
    };
  }

  emitEvent(run: AdapterRun, event: EventEnvelope): void {
    if (run.stream) {
      run.stream.publish(event);
      run.lastSequence = run.stream.lastSequence;
    } else {
      if (run.events.length >= MAX_EVENT_BUFFER) {
        run.events.shift();
      }
      run.events.push(event);
      run.lastSequence = event.sequence;

      for (const subscriber of [...run.subscribers]) {
        try {
          subscriber(event);
        } catch {
          // ignore
        }
      }
    }

    writeRunLog(
      run.logPath,
      formatRunLogLine({
        timestamp: event.timestamp,
        runId: run.runId,
        sequence: event.sequence,
        type: event.type,
        data: event.data,
      }),
      this.maxLogSizeBytes,
    );
  }

  private notifyRunEnded(run: AdapterRun): void {
    if (!run.outcome) {
      run.outcome = {
        runId: run.runId,
        terminalStatus: run.status,
        verifiedStopped: run.verifiedStoppedAt !== null,
        verificationMethod: run.verificationMethod,
        summary: run.status === 'done' ? 'Completed' : undefined,
        error: run.status === 'error' ? 'Run failed' : undefined,
      };
    }
    if (run.stream) {
      run.stream.notifyEnd();
    } else {
      for (const onEnd of [...run.onEndSubscribers]) {
        try {
          onEnd();
        } catch {
          // ignore
        }
      }
    }
  }

  getRunOutcome(runId: string): RunOutcome | null {
    return this.runs.get(runId)?.outcome ?? null;
  }

  private executeScenario(run: AdapterRun, scenario: FakeScenario): void {
    if (scenario === 'crash') {
      // No events emitted, run stays 'running' (models dead adapter or instant crash)
      return;
    }

    if (scenario === 'disconnect') {
      // Emits one event, then drops stream without terminal event (status stays running)
      setTimeout(() => {
        this.emitEvent(run, {
          runId: run.runId,
          sequence: 1,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm1', delta: 'Starting stream...' },
        });

        setTimeout(() => {
          this.notifyRunEnded(run);
        }, 15);
      }, 5);
      return;
    }

    if (scenario === 'hitl') {
      setTimeout(() => {
        this.emitEvent(run, {
          runId: run.runId,
          sequence: 1,
          type: 'message.completed',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm1', content: 'I need more information to proceed.' },
        });

        this.emitEvent(run, {
          runId: run.runId,
          sequence: 2,
          type: 'input_required',
          timestamp: new Date().toISOString(),
          data: {
            requestId: 'req_1',
            question: 'Which environment should I target?',
          },
        });

        run.status = 'hitl';
        run.pendingRequestId = 'req_1';
      }, 5);
      return;
    }

    if (scenario === 'failure') {
      setTimeout(() => {
        this.emitEvent(run, {
          runId: run.runId,
          sequence: 1,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm1', delta: 'Trying task...' },
        });

        this.emitEvent(run, {
          runId: run.runId,
          sequence: 2,
          type: 'failed',
          timestamp: new Date().toISOString(),
          data: {
            errorCode: 'AGENT_ERROR',
            message: 'simulated agent failure',
          },
        });

        run.status = 'error';
        this.clearDeadlineTimer(run);
        run.verifiedStoppedAt = new Date().toISOString();
        run.verificationMethod = 'process_group_empty';
        run.exitCode = 1;

        this.notifyRunEnded(run);
      }, 5);
      return;
    }

    if (scenario === 'duplicate_events') {
      setTimeout(() => {
        this.emitEvent(run, {
          runId: run.runId,
          sequence: 1,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm1', delta: 'First' },
        });

        // Intentional duplicate sequence 1
        this.emitEvent(run, {
          runId: run.runId,
          sequence: 1,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm1', delta: 'First' },
        });

        this.emitEvent(run, {
          runId: run.runId,
          sequence: 2,
          type: 'completed',
          timestamp: new Date().toISOString(),
          data: { summary: 'Task completed' },
        });

        run.status = 'done';
        this.clearDeadlineTimer(run);
        run.verifiedStoppedAt = new Date().toISOString();
        run.verificationMethod = 'process_group_empty';
        run.exitCode = 0;

        this.notifyRunEnded(run);
      }, 5);
      return;
    }

    // Default 'success' scenario
    const isIntake = run.purpose === 'intake';
    const intakeResultContent = isIntake
      ? synthesizeFakeIntakeResultContent(run.instruction)
      : null;
    let intakeResult: IntakeResult | undefined;
    if (intakeResultContent) {
      try {
        intakeResult = IntakeResultSchema.parse(JSON.parse(intakeResultContent));
      } catch {}
    }

    setTimeout(() => {
      if (!intakeResultContent) {
        this.emitEvent(run, {
          runId: run.runId,
          sequence: 1,
          type: 'message.delta',
          timestamp: new Date().toISOString(),
          data: { messageId: 'm1', delta: 'Working...' },
        });
      }

      this.emitEvent(run, {
        runId: run.runId,
        sequence: 2,
        type: 'message.completed',
        timestamp: new Date().toISOString(),
        data: { messageId: 'm1', content: intakeResultContent ?? 'Working on it, done.' },
      });

      this.emitEvent(run, {
        runId: run.runId,
        sequence: 3,
        type: 'completed',
        timestamp: new Date().toISOString(),
        data: { summary: 'Task completed' },
      });

      run.status = 'done';
      this.clearDeadlineTimer(run);
      run.verifiedStoppedAt = new Date().toISOString();
      run.verificationMethod = 'process_group_empty';
      run.exitCode = 0;
      run.outcome = {
        runId: run.runId,
        terminalStatus: 'done',
        intakeResult,
        summary: isIntake ? 'Intake completed' : 'Task completed',
        verifiedStopped: true,
        verificationMethod: 'process_group_empty',
      };

      this.notifyRunEnded(run);
    }, 5);
  }

  private async handleDeadlineTimeout(run: AdapterRun): Promise<void> {
    if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
      return;
    }
    this.clearDeadlineTimer(run);
    const driver = this.drivers.get(run.provider);
    let result: DriverCancelResult = {
      verifiedStopped: true,
      verificationMethod: 'process_group_empty',
    };
    if (!run.scenario && driver) {
      // Await termination before stamping proof — a timeout must not declare
      // verifiedStopped before the process group is actually confirmed gone.
      result = await driver.cancel(run).catch(
        (): DriverCancelResult => ({ verifiedStopped: false, verificationMethod: 'process_group_empty' }),
      );
    }
    stampVerifiedStop(run, result);
    run.status = result.verifiedStopped ? 'error' : 'uncertain';
    run.exitCode = result.verifiedStopped ? 124 : null;
    if (result.verifiedStopped) {
      recordLaunchStopped(run.runId, this.journalPath);
    }

    const seq = run.lastSequence + 1;
    this.emitEvent(run, {
      runId: run.runId,
      sequence: seq,
      type: 'failed',
      timestamp: new Date().toISOString(),
      data: {
        errorCode: 'TIMEOUT',
        message: 'Task exceeded execution deadline (enforced by adapter)',
      },
    });

    this.notifyRunEnded(run);
  }

  private clearDeadlineTimer(run: AdapterRun): void {
    if (run.deadlineTimer) {
      clearTimeout(run.deadlineTimer);
      run.deadlineTimer = undefined;
    }
  }
}
