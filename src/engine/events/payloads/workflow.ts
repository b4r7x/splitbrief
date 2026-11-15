import { z } from 'zod';
import {
  ApproveLevelSchema,
  RunnerKindSchema,
  WorkflowModeSchema,
} from '../../../core/schemas/enums.js';
import { StepCutSchema, StepRefSchema } from '../../../core/schemas/run-step.js';
import { TokenUsageSchema } from '../../../core/schemas/tokens.js';
import { WORKFLOW_CANCEL_REASONS } from '../workflow-cancel.js';
import { noPhaseEvent, phaseEvent, stringArray } from './fields.js';

const WorkflowCancelReasonSchema = z.enum(WORKFLOW_CANCEL_REASONS);

const replayDiagnosticsSchema = z.object({
  totalLines: z.number().int().nonnegative(),
  replayedEvents: z.number().int().nonnegative(),
  skippedBlank: z.number().int().nonnegative(),
  skippedNonEvent: z.number().int().nonnegative(),
  skippedMalformed: z.number().int().nonnegative(),
  skippedUnknown: z.number().int().nonnegative(),
  skippedOversized: z.number().int().nonnegative(),
});

export const WorkflowEventSchemas = [
  phaseEvent('workflow_started').extend({ feature: z.string() }),
  phaseEvent('workflow_resumed').extend({
    /** The same run loop continued in this process; absent on restarts and older logs. */
    inProcess: z.literal(true).optional(),
    /** A held continuation's submit time, before persistence and publication completed. */
    resumedAt: z.number().optional(),
    /** Set when the run continued by itself after a boundary park that only changed a seat. */
    cause: z.literal('seat-change').optional(),
  }),
  phaseEvent('workflow_complete').extend({
    review: z.enum(['passed', 'failed', 'none']).optional(),
    blocking: z.number().int().optional(),
    /** The run's completed briefs, those an earlier process completed included; absent on older logs. */
    completedTasks: z.number().int().nonnegative().optional(),
  }),
  phaseEvent('workflow_cancelled').extend({
    reason: WorkflowCancelReasonSchema.optional(),
    /** An End taken at rest: when it began, before it wrote anything. Absent on a live cancel and older logs. */
    atRestFrom: z.number().optional(),
  }),
  phaseEvent('turn_interrupted').extend({
    source: z.enum(['user', 'watchdog']).optional(),
    /** Where the stop landed: inside the call, or on a boundary — between two briefs, before a review, or at a gate. */
    at: StepCutSchema.optional(),
    /** The step the stop parked, as the state records it; absent on logs written before the field. */
    step: StepRefSchema.optional(),
    /**
     * Set when a boundary park only changes a seat: no pause was asked for, the run stops so the
     * next brief or review starts on the new seat. Absent for a pause the operator asked for.
     */
    cause: z.literal('seat-change').optional(),
    /** The files a brief cut mid-step wrote that are still changed, its declared files first; absent when it kept none. */
    kept: stringArray.optional(),
  }),
  /** The error that stopped the run, as the state records it for the step the run retries. */
  phaseEvent('run_failed').extend({
    step: StepRefSchema,
    message: z.string(),
  }),
  phaseEvent('workflow_config').extend({
    /** Written by runs before modes were retired; read only to replay them. */
    mode: WorkflowModeSchema.optional(),
    plannerTool: z.string(),
    plannerModel: z.string().optional(),
    /** Each seat's kind and axis words; logs written before they were kept have none. */
    plannerKind: RunnerKindSchema.optional(),
    plannerAxes: z.array(z.string()).optional(),
    implementerTool: z.string(),
    implementerModel: z.string().optional(),
    implementerKind: RunnerKindSchema.optional(),
    implementerAxes: z.array(z.string()).optional(),
    /** Absent when the planner holds the review seat. */
    reviewerTool: z.string().optional(),
    reviewerModel: z.string().optional(),
    reviewerKind: RunnerKindSchema.optional(),
    reviewerAxes: z.array(z.string()).optional(),
    /** Present when REVIEW is None for this pass, so no seat reviews it. */
    reviewerSeat: z.literal('none').optional(),
    /** The ids of the skills every seat call of this run carries. */
    skills: z.array(z.string()).optional(),
  }),
  /** Apply began to write the reviewed result to the checkout; the apply review runs inside it. */
  noPhaseEvent('apply_started'),
  /** Apply ended, whatever its outcome. */
  noPhaseEvent('apply_finished'),
  /**
   * `/run reject confirm` put back the run's recorded changes: the files it put back or removed
   * (`removed` is the part of `restored` the run had created), the paths it left as the user
   * changed them, how many had no saved copy, and the folder that holds what it replaced.
   */
  noPhaseEvent('run_rejected').extend({
    restored: stringArray,
    removed: stringArray,
    conflicted: stringArray,
    missing: z.number().int().nonnegative(),
    savedTo: z.string().optional(),
  }),
  phaseEvent('mode_resolved').extend({
    mode: WorkflowModeSchema,
    approve: ApproveLevelSchema,
  }),
  phaseEvent('mode_advice').extend({
    kind: z.enum(['none', 'downgrade', 'upgrade', 'missing-context', 'stop']),
    risk: z.enum(['trivial', 'small', 'normal', 'high']),
    currentMode: WorkflowModeSchema,
    suggestedMode: WorkflowModeSchema,
    confidence: z.number(),
    factors: stringArray,
    missing: stringArray,
  }),
  phaseEvent('cost_update').extend({ tokenUsage: TokenUsageSchema }),
  phaseEvent('workspace_closed'),
  phaseEvent('replay_started').extend({
    totalEvents: z.number(),
    diagnostics: replayDiagnosticsSchema.optional(),
  }),
  /** `processWentAway`: the reopened run's process went away mid-step, so nothing it ran then finished. */
  phaseEvent('replay_complete').extend({
    totalEvents: z.number(),
    durationMs: z.number(),
    diagnostics: replayDiagnosticsSchema.optional(),
    processWentAway: z.literal(true).optional(),
  }),
] as const;
