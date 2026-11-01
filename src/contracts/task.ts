// Task domain schemas: statuses, priorities, task DTOs, repository DTOs.
import { z } from 'zod';

export const TaskStatusSchema = z.enum([
  'todo',
  'processing',
  'hitl',
  'done',
  'error',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const ProviderSchema = z.enum(['claude', 'codex', 'agy']);
export type Provider = z.infer<typeof ProviderSchema>;

export const TaskDepthSchema = z.union([z.literal(0), z.literal(1)]);

// Message-first tasks (specs/2026-10-25-message-intake): `stage` is 'intake'
// until a validated Intake result is accepted, then 'ready' (eligible for
// the implementation claim). Legacy single-repo tasks are backfilled to
// 'ready' with repoId already set (00-overview.md, 01-contracts-and-
// lifecycle.md "Migration and compatibility").
export const TaskStageSchema = z.enum(['intake', 'ready']);
export type TaskStage = z.infer<typeof TaskStageSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  // Nullable: unresolved until Intake accepts a scope (01-contracts-and-
  // lifecycle.md "Resolved task"). `repoId` is the primary resolved repo for
  // the existing single-lock implementation claim; `resolvedRepoIds` is the
  // full accepted scope a multi-repo harness would need (MI-05; enforcing a
  // second writable root per provider remains a documented capability gap,
  // see 01-contracts-and-lifecycle.md "Blocker — live enablement").
  repoId: z.string().nullable(),
  candidateRepoIds: z.array(z.string()).nullable().optional(),
  authorizedRepoIds: z.array(z.string()).nullable().optional(),
  resolvedRepoIds: z.array(z.string()).nullable().optional(),
  stage: TaskStageSchema.optional(),
  executionProvider: ProviderSchema.nullable().optional(),
  intakeRevision: z.number().int().nonnegative().optional(),
  conversationId: z.string().optional(),
  initialMessageId: z.string().nullable().optional(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  parentId: z.string().nullable(),
  depth: TaskDepthSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  blockedReason: z.string().nullable(),
  blockKind: z.string().nullable().optional(),
  blockedOnChildIds: z.array(z.string()).nullable(),
  activeRunId: z.string().nullable(),
  pendingInputRequestId: z.string().nullable().optional(),
  version: z.number().int().nonnegative(),
});
export type Task = z.infer<typeof TaskSchema>;

// Message is the only required business field (00-overview.md "Contract
// changes"). `title`/`priority` are proposed overrides kept fixed once
// supplied; omission means auto-resolve by Intake, not an implicit P2
// override (01-contracts-and-lifecycle.md). `repoId` is accepted as a
// single-repo shorthand for `repoIds`; supplying both is rejected by
// `normalizeRepoHints` below, as is an explicit empty `repoIds` array.
export const CreateTaskInputSchema = z
  .object({
    message: z.string().trim().min(1).max(32 * 1024),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    repoId: z.string().optional(),
    repoIds: z.array(z.string()).optional(),
    priority: TaskPrioritySchema.optional(),
    parentId: z.string().nullable().optional(),
    conversationId: z.string().optional(),
    waitForTaskIds: z.array(z.string()).optional(),
  })
  .refine((value) => !(value.repoId && value.repoIds), {
    message: 'supply either repoId or repoIds, not both',
    path: ['repoIds'],
  })
  .refine((value) => value.repoIds === undefined || value.repoIds.length > 0, {
    message: 'repoIds must not be an empty array; omit it to let Intake resolve scope',
    path: ['repoIds'],
  });
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export function normalizeRepoHints(input: Pick<CreateTaskInput, 'repoId' | 'repoIds'>): string[] {
  if (input.repoIds) {
    return [...new Set(input.repoIds)];
  }
  if (input.repoId) {
    return [input.repoId];
  }
  return [];
}

// Description is removed from the edit surface (00-overview.md "Message:
// ... Remove Description / Context from create/edit forms"). `message`
// corrects the task's own initial chat message, and is only accepted while
// the task is still in 'todo'/'intake' stage, pre-admission — after
// admission, corrections are new task-targeted user messages instead
// (01-contracts-and-lifecycle.md), enforced in updateTaskUsecase, not here.
export const UpdateTaskInputSchema = z
  .object({
    title: z.string().min(1).optional(),
    message: z.string().trim().min(1).max(32 * 1024).optional(),
    priority: TaskPrioritySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  displayPath: z.string(),
  canonicalPath: z.string(),
  defaultProvider: ProviderSchema,
  createdAt: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const CreateRepositoryInputSchema = z.object({
  name: z.string().min(1),
  displayPath: z.string().min(1),
  defaultProvider: ProviderSchema,
});
export type CreateRepositoryInput = z.infer<typeof CreateRepositoryInputSchema>;
