import { z } from 'zod';
import { ActionClassSchema } from '../../../core/schemas/enums.js';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import { noPhaseEvent, phaseEvent } from './fields.js';

// Live gates only ask at `confirm`; `sticky` stays so session logs from before its removal replay.
const ApprovalTierSchema = z.enum(['auto', 'sticky', 'confirm']);

export const ApprovalEventSchemas = [
  phaseEvent('approval_prompted').extend({
    tier: ApprovalTierSchema,
    actionClass: ActionClassSchema,
    taskId: TaskIdSchema.optional(),
  }),
  phaseEvent('approval_granted').extend({
    tier: ApprovalTierSchema,
    actionClass: ActionClassSchema,
    taskId: TaskIdSchema.optional(),
    scope: z.enum(['once', 'session', 'always']),
    confirmReason: z.string().optional(),
  }),
  phaseEvent('approval_rejected').extend({
    tier: ApprovalTierSchema,
    actionClass: ActionClassSchema,
    taskId: TaskIdSchema.optional(),
    reason: z.string(),
  }),
  phaseEvent('approval_sticky_recorded').extend({
    pattern: z.string(),
    scope: z.enum(['session', 'always']),
    actionClass: ActionClassSchema,
  }),
  noPhaseEvent('approval_mode_changed').extend({
    mode: z.enum(['yolo', 'normal']),
  }),
] as const;
