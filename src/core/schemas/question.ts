import { z } from 'zod';

export const ClarificationQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('choice'),
    text: z.string(),
    options: z.array(z.string()),
    default: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('input'),
    text: z.string(),
    default: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('confirm'),
    text: z.string(),
    default: z.boolean().optional(),
  }),
]);

export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
