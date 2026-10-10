import { z } from 'zod';
import type { UserMessageInput } from '../types/user-input.js';

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

export const AnsweredQuestionSchema = z.object({
  question: z.string(),
  answer: z.string(),
});
export type AnsweredQuestion = z.infer<typeof AnsweredQuestionSchema>;

export interface PlannerReplyAnswer {
  message: UserMessageInput;
  qa: AnsweredQuestion[];
}
