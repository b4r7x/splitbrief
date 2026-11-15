import { z } from 'zod';
import { DriftFindingsSchema } from '../../../core/schemas/drift.js';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import { noPhaseEvent, phaseEvent, stringArray } from './fields.js';

const validationStagesSchema = z.object({
  typecheck: z.boolean(),
  lint: z.boolean(),
  test: z.boolean(),
});

const validationStageSkipsSchema = z.object({
  typecheck: z.boolean().optional(),
  lint: z.boolean().optional(),
  test: z.boolean().optional(),
});

const validationStageAttemptsSchema = z.object({
  typecheck: z.boolean(),
  lint: z.boolean(),
  test: z.boolean(),
});

const validationStageCommandsSchema = z.object({
  typecheck: z.string().optional(),
  lint: z.string().optional(),
  test: z.string().optional(),
});

export const BuildEventSchemas = [
  phaseEvent('drift_report').extend({
    passed: z.boolean(),
    errorCount: z.number(),
    warningCount: z.number(),
    findings: DriftFindingsSchema.optional(),
  }),
  phaseEvent('drift_chain_detected').extend({
    chainLength: z.number(),
    score: z.number(),
    threshold: z.number(),
    uniqueOutOfBoundsFiles: stringArray,
    representativePath: z.string(),
  }),
  phaseEvent('snapshot_created').extend({
    snapshotId: z.string(),
    name: z.string().optional(),
    fileCount: z.number(),
    taskIndex: z.number().optional(),
  }),
  noPhaseEvent('snapshot_restored').extend({
    snapshotId: z.string(),
    restoredCount: z.number(),
    conflictedCount: z.number(),
    forcedCount: z.number(),
    forced: z.boolean(),
  }),
  noPhaseEvent('snapshot_restore_conflict').extend({
    snapshotId: z.string(),
    conflictedPaths: stringArray,
  }),
  phaseEvent('implementer_generate_running').extend({
    taskId: TaskIdSchema,
    file: z.string().optional(),
    lineageAttempt: z.number().int().positive().optional(),
    attemptAllowance: z.number().int().positive().optional(),
  }),
  phaseEvent('implementer_generate_done').extend({
    taskId: TaskIdSchema,
    file: z.string(),
    files: z.array(z.string()).optional(),
    diff: z.string().optional(),
    /** Absent when the call's baseline kept no content to count against. */
    linesAdded: z.number().optional(),
    linesRemoved: z.number().optional(),
    duration: z.number(),
    /** An allowed no-change attempt that verified its brief and changed nothing. */
    noChange: z.literal(true).optional(),
    /**
     * The declared files an interrupted attempt of this brief left, which this call continued on.
     * Absent on every other call, and on a log written before the field.
     */
    kept: z.array(z.string()).optional(),
  }),
  phaseEvent('implementer_generate_failed').extend({
    taskId: TaskIdSchema,
    model: z.string().optional(),
    error: z.string().optional(),
  }),
  phaseEvent('validate').extend({
    taskId: TaskIdSchema,
    status: z.enum(['running', 'done', 'stopped']),
    passed: z.boolean(),
    exempt: z.boolean().optional(),
    stages: validationStagesSchema,
    attempted: validationStageAttemptsSchema.optional(),
    activeStage: z.enum(['typecheck', 'lint', 'test']).optional(),
    commands: validationStageCommandsSchema.optional(),
    skipped: validationStageSkipsSchema.optional(),
    skippedReason: z.record(z.string(), z.string()).optional(),
    error: z.string().optional(),
    duration: z.number().optional(),
  }),
  phaseEvent('escalate').extend({
    taskId: TaskIdSchema,
    tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    hint: z.string().optional(),
    tool: z.string().optional(),
    model: z.string().optional(),
  }),
  phaseEvent('git_commit').extend({
    taskId: TaskIdSchema,
    message: z.string(),
    file: z.string().optional(),
    files: stringArray.optional(),
  }),
  phaseEvent('git_checkpoint').extend({
    taskId: TaskIdSchema,
    tag: z.string(),
  }),
  phaseEvent('git_branch_created').extend({ name: z.string() }),
] as const;
