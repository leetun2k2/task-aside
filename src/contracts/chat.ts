// Chat domain schemas: messages and senders.
import { z } from 'zod';

export const MessageSenderSchema = z.enum(['user', 'agent', 'system']);
export type MessageSender = z.infer<typeof MessageSenderSchema>;

// 32 KiB aligns Message/chat limits (01-contracts-and-lifecycle.md "Message
// is a chat message"); existing chat contracts previously enforced only a
// minimum length.
export const MESSAGE_MAX_BYTES = 32 * 1024;

export const MessageSchema = z.object({
  id: z.string(),
  // `taskId` is the message's origin task — which task posted it, not which
  // task is "selected" (01-contracts-and-lifecycle.md; 04-delegation-and-
  // follow-up.md "Shared conversation does not mean shared task state").
  // Required at the contract layer; backfilled for legacy single-task
  // conversations (see migrations.ts backfillLegacyInitialMessages).
  taskId: z.string(),
  conversationId: z.string(),
  sender: MessageSenderSchema,
  content: z.string(),
  inReplyToRequestId: z.string().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const CreateMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(MESSAGE_MAX_BYTES),
  inReplyToRequestId: z.string().optional(),
  // Exact task targeting for a shared conversation (04-delegation-and-
  // follow-up.md "A HITL reply must match conversation, target task and
  // pending request"). Optional for backward compatibility with the
  // existing one-task-per-conversation callers, where the route already
  // knows the task from the URL; required once a conversation is shared by
  // more than one task.
  targetTaskId: z.string().optional(),
});
export type CreateMessageInput = z.infer<typeof CreateMessageInputSchema>;
