// Chat domain schemas: messages and senders.
import { z } from 'zod';

export const MessageSenderSchema = z.enum(['user', 'agent', 'system']);
export type MessageSender = z.infer<typeof MessageSenderSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  conversationId: z.string(),
  sender: MessageSenderSchema,
  content: z.string(),
  inReplyToRequestId: z.string().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const CreateMessageInputSchema = z.object({
  content: z.string().min(1),
  inReplyToRequestId: z.string().optional(),
});
export type CreateMessageInput = z.infer<typeof CreateMessageInputSchema>;
