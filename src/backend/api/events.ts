// Browser SSE projection endpoint (SPECIFICATION.md §3, §7; ARCHITECTURE.md §7; TASKS.md T15).
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { browserAuth } from '../../supervisor/auth.ts';
import { type HubEvent, type SseSubscriber, eventHub } from '../events/hub.ts';

export function mountEventsRoutes(app: Hono, options: { token?: string } = {}): void {
  // SSE accepts token via Authorization: Bearer or ?token=
  app.use('/api/events', browserAuth({ token: options.token }));

  app.get('/api/events', async (c) => {
    if (!eventHub.canAcceptClient()) {
      return c.json(
        {
          code: 'TOO_MANY_CLIENTS',
          message: 'maximum concurrent SSE connections exceeded',
        },
        503,
      );
    }

    const subscriberId = randomUUID();

    return streamSSE(c, async (stream) => {
      let active = true;
      const queue: HubEvent[] = [];
      let isWriting = false;

      const flushQueue = async () => {
        if (!active || isWriting || queue.length === 0) return;
        isWriting = true;
        try {
          while (queue.length > 0 && active) {
            const item = queue.shift();
            if (item) {
              await stream.writeSSE({
                id: item.id,
                event: item.event,
                data: JSON.stringify(item.data),
              });
            }
          }
        } catch {
          active = false;
        } finally {
          isWriting = false;
        }
      };

      const subscriber: SseSubscriber = {
        id: subscriberId,
        getQueueLength: () => queue.length,
        write: async (hubEvent: HubEvent) => {
          if (!active) return;
          queue.push(hubEvent);
          await flushQueue();
        },
        close: () => {
          active = false;
          try {
            void stream.close();
          } catch {
            // ignore
          }
        },
      };

      eventHub.subscribe(subscriber);

      stream.onAbort(() => {
        active = false;
        eventHub.unsubscribe(subscriberId);
      });

      // Send initial connect acknowledgement with current global sequence
      await stream.writeSSE({
        id: String(eventHub.getGlobalSequence()),
        event: 'connected',
        data: JSON.stringify({
          status: 'connected',
          entityVersion: eventHub.getGlobalSequence(),
        }),
      });

      // Keepalive loop while connection is active
      while (active) {
        await stream.sleep(15_000);
        if (active) {
          try {
            await stream.writeSSE({
              event: 'ping',
              data: '{}',
            });
          } catch {
            active = false;
            break;
          }
        }
      }

      eventHub.unsubscribe(subscriberId);
    });
  });
}
