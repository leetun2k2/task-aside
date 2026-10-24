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

export const ProviderSchema = z.enum(['codex', 'claude']);
export type Provider = z.infer<typeof ProviderSchema>;

export const TaskDepthSchema = z.union([z.literal(0), z.literal(1)]);

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  repoId: z.string(),
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

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  repoId: z.string(),
  priority: TaskPrioritySchema.default('P2'),
  parentId: z.string().nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
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
