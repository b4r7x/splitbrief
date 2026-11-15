import { z } from 'zod';
import { AttachedInputSchema } from '../../../core/schemas/attachment.js';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import {
  AnsweredQuestionSchema,
  ClarificationQuestionSchema,
} from '../../../core/schemas/question.js';
import { CREW_SEAT_IDS } from '../../../core/crew/identity.js';
import { phaseEvent } from './fields.js';

export const QueueEventSchemas = [
  phaseEvent('message_queued').extend({
    id: z.string(),
    preview: z.string().optional(),
    origin: z.enum(['user-input', 'clarification']).optional(),
    seat: z.enum(CREW_SEAT_IDS).optional(),
    taskId: z.string().optional(),
    steerable: z.boolean().optional(),
    /** BUILD has not started the brief, so it reads the message when the brief's first call starts. */
    starting: z.boolean().optional(),
  }),
  phaseEvent('message_injected_native').extend({ id: z.string(), preview: z.string().optional() }),
  phaseEvent('queue_drained').extend({
    count: z.number().int().nonnegative(),
    ids: z.array(z.string()).optional(),
    seat: z.enum(CREW_SEAT_IDS).optional(),
    taskId: z.string().optional(),
    via: z.literal('mid-call').optional(),
  }),
  phaseEvent('steerable_call').extend({
    seat: z.enum(CREW_SEAT_IDS).optional(),
    taskId: z.string().optional(),
  }),
  phaseEvent('queue_cleared').extend({ count: z.number().int().nonnegative() }),
  phaseEvent('user_message').extend({
    text: z.string(),
    qa: z.array(AnsweredQuestionSchema).optional(),
    questions: z.array(ClarificationQuestionSchema).min(1).optional(),
    attachedInputs: z.array(AttachedInputSchema).optional(),
  }),
  phaseEvent('build_images_as_paths').extend({
    taskId: TaskIdSchema,
    count: z.number().int().positive(),
  }),
] as const;
