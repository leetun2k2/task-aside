// Scoped MCP tool contracts: 7 tools, and the depth/child ceiling invariants (T05 decision).
import { z } from 'zod';
import { TaskPrioritySchema, TaskStatusSchema } from './task.ts';

export const MAX_TASK_DEPTH = 1;
export const MAX_CHILDREN_PER_TASK = 5;

export const McpToolNameSchema = z.enum([
  'list_tasks',
  'get_task',
  'create_task',
  'get_messages',
  'post_message',
  'request_input',
  'yield_task',
]);
export type McpToolName = z.infer<typeof McpToolNameSchema>;

export const ListTasksParamsSchema = z.object({
  status: TaskStatusSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type ListTasksParams = z.infer<typeof ListTasksParamsSchema>;

export const GetTaskParamsSchema = z.object({
  taskId: z.string().min(1),
});
export type GetTaskParams = z.infer<typeof GetTaskParamsSchema>;

// `repoId` and `idempotencyKey` are optional at the schema layer because
// managed callers (child task creation) inherit the parent's repo and are not
// required to pass either. External callers MUST supply both — enforced in
// `src/backend/mcp/tools.ts#executeCreateTask`, not here, to avoid forking
// this shared tool schema per role (specs/2026-10-24-handoff-single-writer.md
// contract table: "External callers must supply repoId and idempotencyKey.
// Reject missing fields; never select a default repo.").
export const CreateTaskToolParamsSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: TaskPrioritySchema.optional(),
  idempotencyKey: z.string().optional(),
  repoId: z.string().optional(),
});
export type CreateTaskToolParams = z.infer<typeof CreateTaskToolParamsSchema>;

export const GetMessagesParamsSchema = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
});
export type GetMessagesParams = z.infer<typeof GetMessagesParamsSchema>;

export const PostMessageParamsSchema = z.object({
  content: z.string().min(1),
});
export type PostMessageParams = z.infer<typeof PostMessageParamsSchema>;

export const RequestInputParamsSchema = z.object({
  question: z.string().min(1),
});
export type RequestInputParams = z.infer<typeof RequestInputParamsSchema>;

export const YieldTaskParamsSchema = z.object({
  childTaskIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
export type YieldTaskParams = z.infer<typeof YieldTaskParamsSchema>;

export function canCreateChildTask(callerDepth: number): boolean {
  return callerDepth === 0;
}

export function isWithinChildLimit(existingChildCount: number): boolean {
  return existingChildCount < MAX_CHILDREN_PER_TASK;
}
