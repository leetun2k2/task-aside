// Agent adapter run event stream, sequence tracking, and subscriber fanout (RF-44).
// Architecture boundary: isolated from provider process spawning and driver execution.
import type { EventEnvelope } from '../contracts/index.ts';

export const MAX_EVENT_BUFFER = 1000;

export type EventSubscriber = (event: EventEnvelope) => void;
export type EndSubscriber = () => void;

export interface SubscribeParams {
  after: number;
  onEvent: EventSubscriber;
  onEnd: EndSubscriber;
  isTerminal: boolean;
}

export class RunEventStream {
  readonly runId: string;
  private readonly buffer: EventEnvelope[] = [];
  private readonly maxBuffer: number;
  readonly subscribers = new Set<EventSubscriber>();
  readonly onEndSubscribers = new Set<EndSubscriber>();
  private _lastSequence = 0;

  constructor(runId: string, maxBuffer: number = MAX_EVENT_BUFFER) {
    this.runId = runId;
    this.maxBuffer = maxBuffer;
  }

  get lastSequence(): number {
    return this._lastSequence;
  }

  get events(): EventEnvelope[] {
    return [...this.buffer];
  }

  get bufferRef(): EventEnvelope[] {
    return this.buffer;
  }

  publish(event: EventEnvelope): void {
    if (this.buffer.length >= this.maxBuffer) {
      this.buffer.shift();
    }
    this.buffer.push(event);
    this._lastSequence = event.sequence;

    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch {
        // Ignore subscriber delivery errors
      }
    }
  }

  subscribe(params: SubscribeParams): () => void {
    const { after, onEvent, onEnd, isTerminal } = params;

    // Replay past events after specified sequence
    for (const event of this.buffer) {
      if (event.sequence > after) {
        onEvent(event);
      }
    }

    if (isTerminal) {
      onEnd();
      return () => {};
    }

    this.subscribers.add(onEvent);
    this.onEndSubscribers.add(onEnd);

    return () => {
      this.subscribers.delete(onEvent);
      this.onEndSubscribers.delete(onEnd);
    };
  }

  notifyEnd(): void {
    for (const onEnd of [...this.onEndSubscribers]) {
      try {
        onEnd();
      } catch {
        // Ignore subscriber end errors
      }
    }
  }

  clear(): void {
    this.subscribers.clear();
    this.onEndSubscribers.clear();
    this.buffer.length = 0;
  }
}
