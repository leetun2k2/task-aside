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

// `idempotencyKey` is optional at the schema layer because managed callers
// (child task creation, including Intake delegation) derive a stable
// identity from their own run/revision instead
// (specs/2026-10-25-message-intake/01-contracts-and-lifecycle.md "Child
// creation stays MCP-owned"). External callers MUST supply it — enforced in
// `src/backend/mcp/tools.ts#executeCreateTask`, not here, to avoid forking
// this shared tool schema per role (specs/2026-10-24-handoff-single-writer.md
// contract table: "External callers must supply repoId and idempotencyKey.
// Reject missing fields; never select a default repo.").
//
// `message` is the only required business field (specs/2026-10-25-message-
// intake/00-overview.md). `repoId`/`repoIds` are hints, not a constraint —
// Intake may replace or expand them within the caller's authorized scope.
// `waitForTaskIds` is only meaningful together with `parentId` set to the
// delegating task, creating a bounded-prerequisite verification task
// (04-delegation-and-follow-up.md).
export const CreateTaskToolParamsSchema = z.object({
  message: z.string().trim().min(1).max(32 * 1024),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: TaskPrioritySchema.optional(),
  idempotencyKey: z.string().optional(),
  repoId: z.string().optional(),
  repoIds: z.array(z.string()).optional(),
  parentId: z.string().optional(),
  conversationId: z.string().optional(),
  waitForTaskIds: z.array(z.string()).optional(),
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
