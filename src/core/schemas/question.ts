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

/** The default as the card shows it: a confirm's boolean reads Yes or No. */
export function questionDefault(question: ClarificationQuestion): string | undefined {
  return typeof question.default === 'boolean'
    ? question.default
      ? 'Yes'
      : 'No'
    : question.default;
}

export const AnsweredQuestionSchema = z.object({
  question: z.string(),
  answer: z.string(),
});
export type AnsweredQuestion = z.infer<typeof AnsweredQuestionSchema>;

export interface PlannerReplyAnswer {
  message: UserMessageInput;
  qa: AnsweredQuestion[];
  /** The user chose Decide for me: the defaults answer, and the run asks nothing more. */
  decideForMe?: true;
}
