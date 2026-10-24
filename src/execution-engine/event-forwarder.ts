// Execution engine event ingestion, coalescing, and forwarding pipeline (RF-42).
// Architecture boundary: no direct SQLite access in execution engine.
import type { EventEnvelope } from '../contracts/event.ts';
import { type BackendClient, BackendClientError } from './client.ts';
import type { DispatcherOptions } from './types.ts';

export interface PendingDelta {
  runId: string;
  generation: number;
  messageId: string;
  accumulatedDelta: string;
  lastSequence: number;
  timestamp: string;
}

export interface RunStreamState {
  pendingDelta: PendingDelta | null;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  lastAcknowledgedSequence: number;
  forwardedEvents: EventEnvelope[];
}

export function freshStreamState(startAfter: number): RunStreamState {
  return {
    pendingDelta: null,
    deltaTimer: null,
    lastAcknowledgedSequence: startAfter,
    forwardedEvents: [],
  };
}

export interface IngestResult {
  isTerminal: boolean;
  terminalStatus: 'done' | 'error' | 'cancelled' | 'hitl' | null;
  sequence: number;
}

export class EventForwarder {
  private backendClient: BackendClient;
  private options: DispatcherOptions;
  private runStates = new Map<string, RunStreamState>();

  constructor(backendClient: BackendClient, options: DispatcherOptions) {
    this.backendClient = backendClient;
    this.options = options;
  }

  stateFor(runId: string): RunStreamState {
    let state = this.runStates.get(runId);
    if (!state) {
      state = freshStreamState(0);
      this.runStates.set(runId, state);
    }
    return state;
  }

  initRun(runId: string, startAfter = 0): RunStreamState {
    this.retire(runId);
    const state = freshStreamState(startAfter);
    this.runStates.set(runId, state);
    return state;
  }

  getLastAcknowledgedSequence(runId: string): number {
    return this.runStates.get(runId)?.lastAcknowledgedSequence ?? 0;
  }

  getForwardedEvents(runId: string): EventEnvelope[] {
    return [...(this.runStates.get(runId)?.forwardedEvents ?? [])];
  }

  /**
   * Retires a run's stream state — clears timers and frees memory.
   */
  retire(runId: string): void {
    const state = this.runStates.get(runId);
    if (state?.deltaTimer) {
      clearTimeout(state.deltaTimer);
    }
    this.runStates.delete(runId);
  }

  /**
   * Flushes any pending coalesced delta immediately to the backend.
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
   * Forwards durable events to backend with retry on transient failures.
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
   * Ingests an incoming event from the adapter stream.
   * Coalesces deltas without delaying control events.
   */
  async ingestEvent(params: {
    runId: string;
    generation: number;
    event: EventEnvelope;
    simulateLostAck?: boolean;
  }): Promise<IngestResult> {
    const { runId, generation, event, simulateLostAck } = params;
    const state = this.stateFor(runId);

    if (event.type === 'message.delta') {
      if (state.pendingDelta && state.pendingDelta.messageId === event.data.messageId) {
        state.pendingDelta.accumulatedDelta += event.data.delta;
        state.pendingDelta.lastSequence = event.sequence;
        state.pendingDelta.timestamp = event.timestamp;
      } else {
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

      if (!state.deltaTimer) {
        state.deltaTimer = setTimeout(() => {
          this.flushPendingDelta(runId).catch(() => {});
        }, this.options.deltaCoalesceMs ?? 20);
      }

      return {
        isTerminal: false,
        terminalStatus: null,
        sequence: state.lastAcknowledgedSequence,
      };
    }

    // Control or persistent event: flush pending delta immediately
    await this.flushPendingDelta(runId);

    const extraHeaders = simulateLostAck ? { 'x-simulate-lost-ack': 'true' } : undefined;
    await this.forwardWithRetry(runId, generation, [event], extraHeaders);
    state.lastAcknowledgedSequence = Math.max(state.lastAcknowledgedSequence, event.sequence);

    let isTerminal = false;
    let terminalStatus: 'done' | 'error' | 'cancelled' | 'hitl' | null = null;

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

    return {
      isTerminal,
      terminalStatus,
      sequence: state.lastAcknowledgedSequence,
    };
  }
}
