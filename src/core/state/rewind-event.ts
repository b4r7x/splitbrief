import { z } from 'zod';
import { PhaseSchema } from '../schemas/enums.js';
import { TaskIdSchema } from '../schemas/task.js';

const rewindEventBase = z.object({
  ts: z.number(),
  phase: PhaseSchema,
});

export const RewindEventVariantSchemas = [
  rewindEventBase.extend({ type: z.literal('rewind_to_spec'), comment: z.string().optional() }),
  rewindEventBase.extend({ type: z.literal('rewind_to_plan'), comment: z.string().optional() }),
  rewindEventBase.extend({ type: z.literal('task_reset'), taskId: TaskIdSchema }),
] as const;

export const RewindEventSchema = z.discriminatedUnion('type', RewindEventVariantSchemas);

export type RewindEvent = z.infer<typeof RewindEventSchema>;
