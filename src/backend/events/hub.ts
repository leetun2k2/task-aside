// In-memory Event Hub (ARCHITECTURE.md §7, SPECIFICATION.md §3, §7; TASKS.md T15).
// Post-commit event fan-out to browser SSE subscribers. Bounded clients and bounded
// per-client memory: slow clients are closed to force REST reconciliation.

export type BrowserEventType =
  'task.status_changed' | 'message.delta' | 'message.completed' | 'run.changed' | 'input_required';

export interface BrowserEvent {
  type: BrowserEventType;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
}

export interface HubEvent {
  id: string;
  event: BrowserEventType;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface SseSubscriber {
  id: string;
  write: (event: HubEvent) => Promise<void> | void;
  close: () => void;
  getQueueLength?: () => number;
}

export const MAX_SSE_CLIENTS = 100;
export const MAX_BUFFERED_EVENTS_PER_CLIENT = 50;

export class EventHub {
  private subscribers = new Map<string, SseSubscriber>();
  private globalSequence = 0;
  private maxClients: number;
  private maxBufferPerClient: number;

  constructor(options: { maxClients?: number; maxBufferPerClient?: number } = {}) {
    this.maxClients = options.maxClients ?? MAX_SSE_CLIENTS;
    this.maxBufferPerClient = options.maxBufferPerClient ?? MAX_BUFFERED_EVENTS_PER_CLIENT;
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  getGlobalSequence(): number {
    return this.globalSequence;
  }

  canAcceptClient(): boolean {
    return this.subscribers.size < this.maxClients;
  }

  subscribe(subscriber: SseSubscriber): () => void {
    if (!this.canAcceptClient()) {
      throw new Error('MAX_CLIENTS_EXCEEDED');
    }
    this.subscribers.set(subscriber.id, subscriber);

    return () => {
      this.subscribers.delete(subscriber.id);
    };
  }

  unsubscribe(subscriberId: string): void {
    this.subscribers.delete(subscriberId);
  }

  publish(event: BrowserEvent): HubEvent {
    this.globalSequence += 1;
    const seq = this.globalSequence;
    const timestamp = event.timestamp ?? new Date().toISOString();

    const hubEvent: HubEvent = {
      id: String(seq),
      event: event.type,
      data: {
        ...event.data,
        entityVersion: seq,
      },
      timestamp,
    };

    // Fan-out to all connected subscribers
    for (const [id, subscriber] of this.subscribers.entries()) {
      if (subscriber.getQueueLength) {
        const queueLen = subscriber.getQueueLength();
        if (queueLen >= this.maxBufferPerClient) {
          // Slow consumer: terminate connection to force REST reconciliation
          this.subscribers.delete(id);
          try {
            subscriber.close();
          } catch {
            // ignore
          }
          continue;
        }
      }

      try {
        void subscriber.write(hubEvent);
      } catch {
        this.subscribers.delete(id);
        try {
          subscriber.close();
        } catch {
          // ignore
        }
      }
    }

    return hubEvent;
  }

  clear(): void {
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.close();
      } catch {
        // ignore
      }
    }
    this.subscribers.clear();
    this.globalSequence = 0;
  }
}

// Global EventHub singleton instance for the backend process
export const eventHub = new EventHub();
