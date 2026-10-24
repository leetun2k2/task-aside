// Adapter run manager (SPECIFICATION.md §2, §3; ARCHITECTURE.md §6; TASKS.md T16, T17).
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CancelRunRequest,
  EventEnvelope,
  ProvideInputRequest,
  Provider,
  RunStatusResponse,
  StartRunRequest,
} from '../contracts/index.ts';
import { getLogsDir } from '../supervisor/paths.ts';
import { ClaudeDriver } from './drivers/claude.ts';
import { CodexDriver } from './drivers/codex.ts';
import type { AgentDriver } from './drivers/types.ts';
import {
  AdapterError,
  NotFoundError,
  RequestAlreadyResolvedError,
  StaleGenerationError,
  ValidationError,
} from './errors.ts';
import { DEFAULT_MAX_LOG_SIZE_BYTES, formatRunLogLine, writeRunLog } from './logging.ts';
import type { AdapterRun, FakeScenario } from './types.ts';

const MAX_EVENT_BUFFER = 1000;

export class AdapterRunManager {
  private runs = new Map<string, AdapterRun>();
  private drivers = new Map<Provider, AgentDriver>();
  private maxLogSizeBytes: number;

  constructor(options?: {
    codexDriver?: AgentDriver;
    claudeDriver?: AgentDriver;
    maxLogSizeBytes?: number;
  }) {
    this.drivers.set('codex', options?.codexDriver ?? new CodexDriver());
    this.drivers.set('claude', options?.claudeDriver ?? new ClaudeDriver());
    this.maxLogSizeBytes = options?.maxLogSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
  }

  setDriver(provider: Provider, driver: AgentDriver): void {
    this.drivers.set(provider, driver);
  }

  startRun(
    req: StartRunRequest,
    options?: { scenario?: FakeScenario },
  ): { runId: string; started: boolean; existing?: boolean } {
    const existing = this.runs.get(req.runId);
    if (existing) {
      if (existing.ownerId !== req.ownerId || existing.generation !== req.generation) {
        throw new StaleGenerationError(
          `Run ${req.runId} exists with owner ${existing.ownerId} and generation ${existing.generation}`,
        );
      }
      // Repeated start never spawns twice: return existing run info idempotently
      return { runId: req.runId, started: true, existing: true };
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

    const run: AdapterRun = {
      runId: req.runId,
      taskId: req.taskId,
      provider: req.provider,
      cwd: req.cwd,
      instruction: req.instruction,
      ownerId: req.ownerId,
      generation: req.generation,
      sessionId: req.sessionId,
      mcp: req.mcp,
      scenario,
      status: 'running',
      events: [],
      lastSequence: 0,
      pendingRequestId: null,
      verifiedStoppedAt: null,
      verificationMethod: null,
      exitCode: null,
      createdAt: new Date().toISOString(),
      subscribers: new Set(),
      onEndSubscribers: new Set(),
      logPath,
      deadlineAt: req.deadlineAt,
    };

    if (req.deadlineAt) {
      const ms = new Date(req.deadlineAt).getTime() - Date.now();
      run.deadlineTimer = setTimeout(() => {
        this.handleDeadlineTimeout(run);
      }, Math.max(0, ms));
    }

    this.runs.set(req.runId, run);

    if (scenario) {
      this.executeScenario(run, scenario);
    } else {
      const driver = this.drivers.get(req.provider);
      if (driver) {
        Promise.resolve()
          .then(() =>
            driver.start(run, {
              onEvent: (event: EventEnvelope) => this.emitEvent(run, event),
              onEnd: () => {
                this.clearDeadlineTimer(run);
                if (run.status === 'running') {
                  run.status = 'done';
                  run.verifiedStoppedAt = new Date().toISOString();
                  run.verificationMethod = 'process_group_empty';
                  run.exitCode = 0;
                }
                for (const onEnd of run.onEndSubscribers) {
                  try {
                    onEnd();
                  } catch {
                    // ignore
                  }
                }
              },
              onSessionId: (sid: string) => {
                run.sessionId = sid;
              },
            }),
          )
          .catch((err: unknown) => {
            this.clearDeadlineTimer(run);
            run.status = 'error';
            run.verifiedStoppedAt = new Date().toISOString();
            run.verificationMethod = 'process_group_empty';
            run.exitCode = 1;
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
            for (const onEnd of run.onEndSubscribers) {
              try {
                onEnd();
              } catch {
                // ignore
              }
            }
          });
      } else {
        this.executeScenario(run, 'success');
      }
    }

    return { runId: req.runId, started: true };
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

    // Replay past events after specified sequence
    for (const event of run.events) {
      if (event.sequence > after) {
        onEvent(event);
      }
    }

    // If run has already reached a terminal state, signal end
    if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
      onEnd();
      return () => {};
    }

    run.subscribers.add(onEvent);
    run.onEndSubscribers.add(onEnd);

    if (run.scenario === 'disconnect') {
      setTimeout(() => {
        onEnd();
      }, 15);
    }

    return () => {
      run.subscribers.delete(onEvent);
      run.onEndSubscribers.delete(onEnd);
    };
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

      for (const onEnd of run.onEndSubscribers) {
        try {
          onEnd();
        } catch {
          // ignore
        }
      }
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
        verifiedStopped: true,
        verificationMethod: run.verificationMethod ?? 'process_group_empty',
      };
    }

    const driver = this.drivers.get(run.provider);
    if (!run.scenario && driver) {
      const cancelRes = await driver.cancel(run);
      run.status = 'cancelled';
      run.verifiedStoppedAt = new Date().toISOString();
      run.verificationMethod = cancelRes.verificationMethod;
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

    for (const onEnd of run.onEndSubscribers) {
      try {
        onEnd();
      } catch {
        // ignore
      }
    }

    return {
      runId: run.runId,
      verifiedStopped: true,
      verificationMethod: 'process_group_empty',
    };
  }

  emitEvent(run: AdapterRun, event: EventEnvelope): void {
    if (run.events.length >= MAX_EVENT_BUFFER) {
      run.events.shift();
    }
    run.events.push(event);
    run.lastSequence = event.sequence;

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

    for (const subscriber of run.subscribers) {
      try {
        subscriber(event);
      } catch {
        // ignore
      }
    }
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
          for (const onEnd of run.onEndSubscribers) {
            try {
              onEnd();
            } catch {
              // ignore
            }
          }
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

        for (const onEnd of run.onEndSubscribers) {
          try {
            onEnd();
          } catch {
            // ignore
          }
        }
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

        for (const onEnd of run.onEndSubscribers) {
          try {
            onEnd();
          } catch {
            // ignore
          }
        }
      }, 5);
      return;
    }

    // Default 'success' scenario
    setTimeout(() => {
      this.emitEvent(run, {
        runId: run.runId,
        sequence: 1,
        type: 'message.delta',
        timestamp: new Date().toISOString(),
        data: { messageId: 'm1', delta: 'Working...' },
      });

      this.emitEvent(run, {
        runId: run.runId,
        sequence: 2,
        type: 'message.completed',
        timestamp: new Date().toISOString(),
        data: { messageId: 'm1', content: 'Working on it, done.' },
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

      for (const onEnd of run.onEndSubscribers) {
        try {
          onEnd();
        } catch {
          // ignore
        }
      }
    }, 5);
  }

  private handleDeadlineTimeout(run: AdapterRun): void {
    if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
      return;
    }
    this.clearDeadlineTimer(run);
    const driver = this.drivers.get(run.provider);
    if (!run.scenario && driver) {
      driver.cancel(run).catch(() => {});
    }
    run.status = 'error';
    run.verifiedStoppedAt = new Date().toISOString();
    run.verificationMethod = 'process_group_empty';
    run.exitCode = 124;

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

    for (const onEnd of run.onEndSubscribers) {
      try {
        onEnd();
      } catch {
        // ignore
      }
    }
  }

  private clearDeadlineTimer(run: AdapterRun): void {
    if (run.deadlineTimer) {
      clearTimeout(run.deadlineTimer);
      run.deadlineTimer = undefined;
    }
  }
}
