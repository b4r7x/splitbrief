import { z } from 'zod';
import {
  CurrentCodeContextModeSchema,
  FileActionSchema,
  TaskCompletionMethodSchema,
  TaskContextFitSchema,
  TaskStatusSchema,
} from '../../../core/schemas/enums.js';
import { CheckResultSchema, TaskIdSchema } from '../../../core/schemas/task.js';
import {
  CONSULT_ACTION_KINDS,
  ConsultRecordSchema,
} from '../../../core/schemas/workflow/consult-record.js';
import { CONSULT_REASONS } from '../../../core/schemas/consult.js';
import { TaskReviewRecoverySchema } from '../../../core/schemas/recovery/schemas.js';
import { BriefExecutionSchema } from '../../../core/schemas/brief-execution.js';
import { runnerCallContextFields } from '../../calls/schema.js';
import { phaseEvent, stringArray, taskIdArray } from './fields.js';

const TASK_REVIEW_COMMANDS = [
  'continue',
  'redo-task',
  'edit-notes',
  'revise-plan',
  'abort',
] as const;

const taskReviewRequestFields = {
  taskId: TaskIdSchema,
  taskTitle: z.string(),
  status: z.union([TaskStatusSchema, z.literal('recovery-required')]),
  filesTouched: stringArray,
  validation: z.looseObject({
    passed: z.boolean().nullable(),
    summary: z.string(),
    stages: z.array(
      z.looseObject({
        stage: z.string(),
        passed: z.boolean(),
        errorSummary: z.string().optional(),
      }),
    ),
  }),
  evidence: z.looseObject({
    path: z.string().optional(),
    summary: z.string(),
    expected: stringArray,
    observed: stringArray,
  }),
  seat: z
    .object({
      tool: z.string().optional(),
      model: z.string().optional(),
      implementerProfile: z.string().optional(),
    })
    .optional(),
  routing: z
    .object({
      selectedProfile: z.string().optional(),
      fit: TaskContextFitSchema,
      currentCodeTruncated: z.boolean(),
      currentCodeContextMode: CurrentCodeContextModeSchema,
      reason: z.string(),
    })
    .optional(),
  recovery: TaskReviewRecoverySchema.optional(),
  availableCommands: z.array(z.enum(TASK_REVIEW_COMMANDS)),
} as const;

export const TaskEventSchemas = [
  phaseEvent('all_tasks_done'),
  phaseEvent('tasks_planned').extend({
    tasks: z.array(
      z.object({
        id: TaskIdSchema,
        title: z.string(),
        index: z.number().int().nonnegative(),
        file: z.string(),
        action: FileActionSchema,
      }),
    ),
    total: z.number().int().nonnegative(),
  }),
  phaseEvent('task_started').extend({
    taskId: TaskIdSchema,
    title: z.string(),
    index: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** The attempt this brief's lineage is on, and its allowance; absent on older logs. */
    lineageAttempt: z.number().int().positive().optional(),
    attemptAllowance: z.number().int().nonnegative().optional(),
    file: z.string(),
    files: stringArray.optional(),
    action: FileActionSchema,
    tool: z.string().optional(),
    model: z.string().optional(),
    axes: runnerCallContextFields.axes,
    backendKind: runnerCallContextFields.backendKind.optional(),
    implementerProfile: z.string().optional(),
    contextFit: TaskContextFitSchema.optional(),
    currentCodeTruncated: z.boolean().optional(),
    currentCodeContextMode: CurrentCodeContextModeSchema.optional(),
    routingReason: z.string().optional(),
  }),
  phaseEvent('task_completed').extend({
    taskId: TaskIdSchema,
    title: z.string(),
    method: TaskCompletionMethodSchema,
    retries: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    tool: z.string().optional(),
    model: z.string().optional(),
    implementerProfile: z.string().optional(),
  }),
  phaseEvent('task_skipped').extend({
    taskId: TaskIdSchema,
    title: z.string(),
    reason: z.string(),
  }),
  phaseEvent('task_retry').extend({
    taskId: TaskIdSchema,
    attempt: z.number().int().nonnegative(),
    maxRetries: z.number().int().nonnegative(),
    /** The attempt this retry is on its lineage, and the lineage's allowance; absent on older logs. */
    lineageAttempt: z.number().int().positive().optional(),
    attemptAllowance: z.number().int().nonnegative().optional(),
    error: z.string(),
  }),
  phaseEvent('task_escalating').extend({ taskId: TaskIdSchema }),
  phaseEvent('task_scope_widened').extend({
    taskId: TaskIdSchema,
    paths: stringArray,
    reason: z.string(),
  }),
  phaseEvent('task_touched_not_suggested').extend({ taskId: TaskIdSchema, files: stringArray }),
  phaseEvent('task_full_fail').extend({ taskId: TaskIdSchema, reason: z.string().optional() }),
  z.object({
    ...phaseEvent('task_settled').shape,
    ...BriefExecutionSchema.partial({ taskTitle: true }).shape,
  }),
  phaseEvent('task_review_needed').extend(taskReviewRequestFields),
  phaseEvent('hint_failed').extend({ taskId: TaskIdSchema }),
  phaseEvent('consult_answered').extend({
    taskId: TaskIdSchema,
    /**
     * `deviation` and `confirm` are written by runs before decisions went to the ledger, and
     * `stale` by runs before a brief whose input files moved dispatched without a planner call;
     * read only to replay them.
     */
    reason: z.enum([...CONSULT_REASONS, 'deviation', 'stale']),
    action: z.enum([...CONSULT_ACTION_KINDS, 'confirm']),
    seat: ConsultRecordSchema.shape.seat,
    diagnosis: z.string(),
    newTaskIds: taskIdArray.nullable(),
    revision: z.number().int().optional(),
    checkIds: z.array(z.string()).optional(),
    /** The planner's note when it accepts a stuck review's blockers. */
    note: z.string().optional(),
    /** Written by runs before decisions went to the ledger; read only to replay them. */
    decisionCount: z.number().int().nonnegative().optional(),
    /** Written by runs before decisions went to the ledger; read only to replay them. */
    rejectedCount: z.number().int().nonnegative().optional(),
  }),
  phaseEvent('task_replaced').extend({
    taskId: TaskIdSchema,
    revision: z.number().int(),
  }),
  phaseEvent('tasks_inserted').extend({
    parentId: TaskIdSchema,
    taskIds: taskIdArray,
  }),
  /**
   * A brief entered its validation (no `check`), then each of its plan checks starts (`check`).
   * It has no transcript row: the byline and the activity line name the check while it runs.
   */
  phaseEvent('task_validating').extend({
    taskId: TaskIdSchema,
    check: z
      .object({ id: z.string(), command: z.string(), scenario: z.string().optional() })
      .optional(),
  }),
  phaseEvent('checks_run').extend({
    taskId: TaskIdSchema,
    results: z.array(CheckResultSchema),
  }),
] as const;
