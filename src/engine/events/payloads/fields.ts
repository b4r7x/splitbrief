import { z } from 'zod';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import { TaskIdSchema } from '../../../core/schemas/task.js';

export const stringArray = z.array(z.string());
export const taskIdArray = z.array(TaskIdSchema);

export function phaseEvent<T extends string>(type: T) {
  return z.looseObject({
    type: z.literal(type),
    ts: z.number(),
    phase: PhaseSchema,
  });
}

export function noPhaseEvent<T extends string>(type: T) {
  return z.looseObject({
    type: z.literal(type),
    ts: z.number(),
  });
}
