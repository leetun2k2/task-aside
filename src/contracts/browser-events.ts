// Typed browser event contracts for SSE streaming (ARCHITECTURE.md §7; SPECIFICATION.md §3, §7; RF-16).
// Defines strictly validated schemas for all browser projections broadcast over /api/events.
import { z } from 'zod';
import { TaskStatusSchema } from './task.ts';

export const BrowserTaskStatusChangedSchema = z.object({
  taskId: z.string().min(1),
  status: TaskStatusSchema,
  version: z.number().int().nonnegative(),
  updatedAt: z.string(),
  blockedReason: z.string().nullable().optional(),
  blockKind: z.string().nullable().optional(),
  entityVersion: z.number().int().positive().optional(),
});
export type BrowserTaskStatusChanged = z.infer<typeof BrowserTaskStatusChangedSchema>;

export const BrowserMessageDeltaSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  messageId: z.string().min(1),
  delta: z.string(),
  entityVersion: z.number().int().positive().optional(),
});
export type BrowserMessageDelta = z.infer<typeof BrowserMessageDeltaSchema>;

export const BrowserMessageCompletedSchema = z.object({
  messageId: z.string().min(1),
  taskId: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(['user', 'agent', 'system']),
  content: z.string(),
  // runId is present for agent-completed messages where backend knows it; absent for human posts
  runId: z.string().min(1).optional(),
  createdAt: z.string(),
  entityVersion: z.number().int().positive().optional(),
});
export type BrowserMessageCompleted = z.infer<typeof BrowserMessageCompletedSchema>;

export const BrowserRunChangedSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  status: z.string().min(1),
  entityVersion: z.number().int().positive().optional(),
});
export type BrowserRunChanged = z.infer<typeof BrowserRunChangedSchema>;

export const BrowserInputRequiredSchema = z.object({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  conversationId: z.string().min(1),
  question: z.string(),
  entityVersion: z.number().int().positive().optional(),
});
export type BrowserInputRequired = z.infer<typeof BrowserInputRequiredSchema>;

export const BrowserEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.status_changed'),
    data: BrowserTaskStatusChangedSchema,
  }),
  z.object({
    type: z.literal('message.delta'),
    data: BrowserMessageDeltaSchema,
  }),
  z.object({
    type: z.literal('message.completed'),
    data: BrowserMessageCompletedSchema,
  }),
  z.object({
    type: z.literal('run.changed'),
    data: BrowserRunChangedSchema,
  }),
  z.object({
    type: z.literal('input_required'),
    data: BrowserInputRequiredSchema,
  }),
]);
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;

/**
 * Safely parses and normalizes browser SSE event data with legacy payload fallback.
 */
export function parseBrowserEventPayload(type: string, rawData: unknown): unknown {
  switch (type) {
    case 'task.status_changed':
      return BrowserTaskStatusChangedSchema.safeParse(rawData);
    case 'message.delta':
      return BrowserMessageDeltaSchema.safeParse(rawData);
    case 'message.completed':
      return BrowserMessageCompletedSchema.safeParse(rawData);
    case 'run.changed':
      return BrowserRunChangedSchema.safeParse(rawData);
    case 'input_required':
      return BrowserInputRequiredSchema.safeParse(rawData);
    default:
      return { success: false, error: new Error(`unknown browser event type: ${type}`) };
  }
}
