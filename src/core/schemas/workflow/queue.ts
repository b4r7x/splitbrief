import { z } from 'zod';
import { AttachmentSchema, AttachedInputSchema } from '../attachment.js';
import { PhaseSchema } from '../enums.js';

export const QueuedMessageSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    displayText: z.string().optional(),
    images: z.array(AttachmentSchema).default([]),
    attachedInputs: z.array(AttachedInputSchema).default([]),
    queuedAt: z.string(),
    phase: PhaseSchema,
    deliveredViaNative: z.boolean(),
    nativeDeliveryState: z.enum(['pending', 'injecting', 'delivered']).default('pending'),
    possibleDuplicate: z.boolean().optional(),
    deliveredMidCall: z.literal(true).optional(),
    drainedAt: z.string().optional(),
    deliveredTo: z
      .object({
        implementer: z.string().optional(),
        reviewer: z.string().optional(),
      })
      .optional(),
    origin: z.enum(['user-input', 'clarification']).optional(),
    question: z.string().optional(),
  })
  .transform((message) => ({
    ...message,
    displayText: message.displayText ?? message.text,
  }));
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
