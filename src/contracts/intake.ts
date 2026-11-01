// Intake result contract (specs/2026-10-25-message-intake/01-contracts-and-
// lifecycle.md "Intake result is structured data"). This is the ONE final
// JSON object the adapter extracts from the provider's structured output —
// never parsed from Markdown fences, raw logs, or arbitrary braces in prose
// (the adapter's extraction boundary) — which the engine validates against
// this shared schema before forwarding to the backend's independent,
// authoritative persistence/authorization checks in commit-intake-result-
// usecase.ts. Streaming envelopes (src/contracts/event.ts) are a separate
// concern; this schema never appears inside one.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderSchema, TaskPrioritySchema } from './task.ts';

export const IntakeActionSchema = z.enum(['implement', 'delegate', 'request_input']);
export type IntakeAction = z.infer<typeof IntakeActionSchema>;

const IntakeResultBaseSchema = z.object({
  version: z.literal(1),
  reason: z.string().optional(),
});

export const IntakeImplementResultSchema = IntakeResultBaseSchema.extend({
  action: z.literal('implement'),
  title: z.string().min(1),
  repoIds: z.array(z.string()).min(1),
  priority: TaskPrioritySchema,
  executionProvider: ProviderSchema,
  goal: z.string().min(1),
}).strict();

export const IntakeDelegateResultSchema = IntakeResultBaseSchema.extend({
  action: z.literal('delegate'),
  title: z.string().min(1),
  priority: TaskPrioritySchema,
  childTaskIds: z.array(z.string()).min(1),
  verificationTaskId: z.string().optional(),
}).strict();

export const IntakeRequestInputResultSchema = IntakeResultBaseSchema.extend({
  action: z.literal('request_input'),
  question: z.string().min(1),
  // Title/priority overrides may still be preserved verbatim even when the
  // scope/provider remain unresolved (01-contracts-and-lifecycle.md "For
  // request_input ... unresolved repos/provider may be absent").
  title: z.string().min(1).optional(),
  priority: TaskPrioritySchema.optional(),
}).strict();

export const IntakeResultSchema = z.discriminatedUnion('action', [
  IntakeImplementResultSchema,
  IntakeDelegateResultSchema,
  IntakeRequestInputResultSchema,
]);
export type IntakeResult = z.infer<typeof IntakeResultSchema>;

export function computeRoutingPolicyHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex').slice(0, 16);
}

/** Routing instruction bundled as one versioned Markdown resource (03-agent-
 * routing.md). The version/hash travels with every accepted Intake decision
 * (01-contracts-and-lifecycle.md "Persist the accepted result ... routing-
 * policy version/hash"). Bump this whenever the Markdown content changes. */
export const ROUTING_INSTRUCTION_VERSION = 1;

export const INTAKE_DEADLINE_MS = 120_000;

// Internal engine -> backend contract for the Intake gate
// (01-contracts-and-lifecycle.md "Internal Intake result commit").
export const CommitIntakeResultRequestSchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  verifiedStopped: z.literal(true),
  verificationMethod: z.enum(['process_group_empty', 'ps_fingerprint_absent']),
  result: IntakeResultSchema,
  routingInstructionVersion: z.number().int().nonnegative(),
});
export type CommitIntakeResultRequest = z.infer<typeof CommitIntakeResultRequestSchema>;

export const FailIntakeRequestSchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  verifiedStopped: z.boolean(),
  verificationMethod: z.enum(['process_group_empty', 'ps_fingerprint_absent']).optional(),
  reason: z.string().min(1),
});
export type FailIntakeRequest = z.infer<typeof FailIntakeRequestSchema>;
