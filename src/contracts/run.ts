// Run lifecycle, fencing (ownerId/generation) and agent-adapter contracts.
import { z } from 'zod';
import { ProviderSchema, TaskSchema } from './task.ts';

export const RunStatusSchema = z.enum([
  'running',
  'hitl',
  'done',
  'error',
  'cancelled',
  'uncertain',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const VerificationMethodSchema = z.enum(['process_group_empty', 'ps_fingerprint_absent']);
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>;

export const ClaimTaskRequestSchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
});
export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequestSchema>;

export const ClaimTaskResponseSchema = z.object({
  runId: z.string(),
  generation: z.number().int().nonnegative(),
  leaseExpiresAt: z.string(),
  taskSnapshot: TaskSchema,
  // Durable 60-minute deadline (specs/2026-10-24-polling-worker-pool.md), set
  // once at claim and never recomputed on resume/retry/restart.
  deadlineAt: z.string(),
  workingTreeKey: z.string().optional(),
});
export type ClaimTaskResponse = z.infer<typeof ClaimTaskResponseSchema>;

// Atomic bulk-admission request/response: the backend picks the next eligible
// task itself (short indexed query, no full-backlog transfer) instead of the
// engine fetching the whole runnable backlog and looping claim-by-id.
export const AdmitTaskRequestSchema = z.object({
  ownerId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type AdmitTaskRequest = z.infer<typeof AdmitTaskRequestSchema>;

export const AdmitSkipReasonSchema = z.enum([
  'concurrency_limit_reached',
  'no_runnable_tasks',
  'all_trees_busy',
]);
export type AdmitSkipReason = z.infer<typeof AdmitSkipReasonSchema>;

export const AdmitTaskResponseSchema = z.union([
  ClaimTaskResponseSchema.extend({ admitted: z.literal(true) }),
  z.object({ admitted: z.literal(false), reason: AdmitSkipReasonSchema }),
]);
export type AdmitTaskResponse = z.infer<typeof AdmitTaskResponseSchema>;

export const HeartbeatRequestSchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

const TerminalRunStatusSchema = z.enum(['done', 'error', 'cancelled']);

export const FinalizeRunRequestSchema = z
  .object({
    ownerId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    status: TerminalRunStatusSchema,
    verifiedStopped: z.boolean(),
    verificationMethod: VerificationMethodSchema.optional(),
    summary: z.string().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .refine(
    (value) =>
      !TerminalRunStatusSchema.options.includes(value.status) ||
      (value.verifiedStopped && value.verificationMethod !== undefined),
    {
      message: 'Terminal finalize requires verifiedStopped:true and a verificationMethod',
      path: ['verifiedStopped'],
    },
  );
export type FinalizeRunRequest = z.infer<typeof FinalizeRunRequestSchema>;

export const MarkUncertainRequestSchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  reason: z.string().min(1),
});
export type MarkUncertainRequest = z.infer<typeof MarkUncertainRequestSchema>;

export const ClearQuarantineRequestSchema = z.object({
  operatorId: z.string().min(1),
  reason: z.string().min(1),
});
export type ClearQuarantineRequest = z.infer<typeof ClearQuarantineRequestSchema>;

export const CancelRunRequestSchema = z.object({
  ownerId: z.string().min(1).optional(),
  generation: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

export const ProvideInputRequestSchema = z.object({
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  requestId: z.string().min(1).optional(),
  response: z.string().min(1),
});
export type ProvideInputRequest = z.infer<typeof ProvideInputRequestSchema>;

export const StartRunRequestSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  provider: ProviderSchema,
  cwd: z.string().min(1),
  instruction: z.string().min(1),
  ownerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  mcp: z
    .object({
      endpoint: z.string(),
      accessToken: z.string(),
    })
    .optional(),
  // Durable per-attempt deadline, threaded through so the adapter can enforce
  // it independently even if the engine exits (specs/2026-10-24-polling-worker-pool.md).
  // Optional for backward compatibility; the engine always supplies it.
  deadlineAt: z.string().optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const ProviderCapabilitySchema = z.object({
  available: z.boolean(),
  resume: z.boolean(),
  mcp: z.boolean(),
  version: z.string().optional(),
  notes: z.string().optional(),
});
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const CapabilitiesResponseSchema = z.object({
  providers: z.object({
    codex: ProviderCapabilitySchema,
    claude: ProviderCapabilitySchema,
  }),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

export const ProcessStateSchema = z.object({
  status: RunStatusSchema,
  verifiedStoppedAt: z.string().nullable(),
  verificationMethod: VerificationMethodSchema.nullable(),
  exitCode: z.number().int().nullable(),
});
export type ProcessState = z.infer<typeof ProcessStateSchema>;

export const RunStatusResponseSchema = z.object({
  runId: z.string(),
  processState: ProcessStateSchema,
});
export type RunStatusResponse = z.infer<typeof RunStatusResponseSchema>;
