// Flat run event envelope (T05 decision) and event-hash helper for idempotent dedup.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';

export const MessageDeltaDataSchema = z.object({
  messageId: z.string(),
  delta: z.string(),
});

export const MessageCompletedDataSchema = z.object({
  messageId: z.string(),
  content: z.string(),
});

export const InputRequiredDataSchema = z.object({
  requestId: z.string(),
  question: z.string(),
});

export const CompletedDataSchema = z.object({
  summary: z.string(),
});

export const FailedDataSchema = z.object({
  errorCode: z.string(),
  message: z.string(),
});

export const CancelledDataSchema = z.object({});

const EnvelopeBaseSchema = z.object({
  runId: z.string(),
  sequence: z.number().int().positive(),
  timestamp: z.string(),
});

export const EventEnvelopeSchema = z.discriminatedUnion('type', [
  EnvelopeBaseSchema.extend({
    type: z.literal('message.delta'),
    data: MessageDeltaDataSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal('message.completed'),
    data: MessageCompletedDataSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal('input_required'),
    data: InputRequiredDataSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal('completed'),
    data: CompletedDataSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal('failed'),
    data: FailedDataSchema,
  }),
  EnvelopeBaseSchema.extend({
    type: z.literal('cancelled'),
    data: CancelledDataSchema,
  }),
]);
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type AgentEventType = EventEnvelope['type'];

export const PERSISTENT_EVENT_TYPES: AgentEventType[] = [
  'message.completed',
  'input_required',
  'completed',
  'failed',
  'cancelled',
];

export function computeEventHash(envelope: EventEnvelope): string {
  const { runId, sequence, type, data } = envelope;
  const canonical = canonicalJson({ runId, sequence, type, data });
  return createHash('sha256').update(canonical).digest('hex');
}

export const IngestEventsRequestSchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  events: z.array(EventEnvelopeSchema),
});
export type IngestEventsRequest = z.infer<typeof IngestEventsRequestSchema>;
