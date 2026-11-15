import { z } from 'zod';
import { RecoveryActionSchema, RecoveryReasonSchema } from '../../../core/schemas/enums.js';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import { StepRefSchema } from '../../../core/schemas/run-step.js';
import { RecoveryIssueSchema } from '../../../core/schemas/recovery/schemas.js';
import { CREW_SEAT_IDS } from '../../../core/crew/identity.js';
import { phaseEvent, stringArray, taskIdArray } from './fields.js';

/** The seat a recovery event is about; absent on logs written before the field existed. */
const recoverySeat = z.enum(CREW_SEAT_IDS).optional();

export const RecoveryEventSchemas = [
  phaseEvent('recovery_prompted').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    taskId: TaskIdSchema.optional(),
    files: stringArray,
    affectedTaskIds: taskIdArray,
    availableActions: z.array(RecoveryActionSchema),
    recommendedAction: RecoveryActionSchema,
    headline: z.string(),
    headlineSpans: z.array(z.object({ text: z.string(), seat: recoverySeat })).optional(),
    resumeCommand: z.string(),
    /** The halt itself and the step the run resumes at; a log written before them has neither. */
    issue: RecoveryIssueSchema.optional(),
    at: StepRefSchema.optional(),
  }),
  phaseEvent('recovery_action_selected').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    seat: recoverySeat,
    reviewNone: z.literal(true).optional(),
  }),
  phaseEvent('recovery_action_failed').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    seat: recoverySeat,
    message: z.string(),
  }),
  phaseEvent('recovery_resolved').extend({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    seat: recoverySeat,
    outcome: z.enum(['continued', 'retry-current-task', 'skipped-current-task', 'aborted']),
    implementerProfile: z.string().optional(),
  }),
] as const;
