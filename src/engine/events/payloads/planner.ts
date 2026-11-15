import { z } from 'zod';
import { ClarificationQuestionSchema } from '../../../core/schemas/question.js';
import { PlannerCallSchema } from '../../../core/schemas/run-step.js';
import { RewindEventVariantSchemas } from '../../../core/state/rewind-event.js';
import { CallIdSchema } from '../../calls/schema.js';
import { phaseEvent, stringArray } from './fields.js';

export const PlannerEventSchemas = [
  phaseEvent('planner_status').extend({
    status: z.enum(['running', 'done']),
    tool: z.string().optional(),
    model: z.string().optional(),
    duration: z.number().optional(),
    summary: z.string().optional(),
    call: PlannerCallSchema.optional(),
  }),
  phaseEvent('planner_text').extend({
    text: z.string(),
    role: z.enum(['planner', 'implementer']).optional(),
    content: z.enum(['plain', 'markdown']).optional(),
    /** First chunk of a new implementer message; absent in older logs and continuous streams. */
    messageStart: z.boolean().optional(),
    /** The held end of a word: it joins the text row it ends, past the tool rows of its hold. */
    continues: z.literal(true).optional(),
    /** The sub-agent that wrote the text; absent for the main text and in older logs. */
    subagentId: CallIdSchema.optional(),
  }),
  phaseEvent('planner_heartbeat').extend({
    elapsedMs: z.number(),
    callId: CallIdSchema.optional(),
  }),
  phaseEvent('instant_plan_received').extend({ taskCount: z.number() }),
  phaseEvent('clarifications_collected').extend({
    count: z.number(),
    clarifications: z.array(
      z.looseObject({
        question: z.string(),
        answer: z.string(),
      }),
    ),
  }),
  phaseEvent('clarification_answered').extend({
    answer: z.string(),
  }),
  /** The questions the run waits on the operator to answer, before the answer arrives. */
  phaseEvent('planner_questions_asked').extend({
    questions: z.array(ClarificationQuestionSchema).min(1),
  }),
  phaseEvent('planner_attachments_dropped').extend({
    count: z.number(),
    reason: z.enum(['unsupported-backend', 'capability-degraded']),
  }),
  phaseEvent('artifact_written').extend({
    filename: z.string(),
    path: z.string(),
    lineCount: z.number().int().nonnegative(),
    excerpt: stringArray,
    omittedCount: z.number().int().nonnegative(),
    omittedUnit: z.enum(['line', 'section', 'task']),
  }),
  phaseEvent('spec_approved'),
  phaseEvent('spec_rejected'),
  phaseEvent('spec_regenerated').extend({ comment: z.string() }),
  /** The plan card opened and waits for the operator's approval. */
  phaseEvent('plan_card_opened'),
  phaseEvent('plan_approved'),
  phaseEvent('plan_rejected'),
  phaseEvent('plan_regenerated').extend({ comment: z.string() }),
  phaseEvent('briefs_approved'),
  phaseEvent('briefs_rejected'),
  ...RewindEventVariantSchemas,
] as const;
