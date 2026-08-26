import { z } from 'zod';
import { PhaseSchema, ApproveLevelSchema, WorkflowModeSchema } from '../../schemas/enums.js';
import { TaskSchema } from '../../schemas/task.js';
import { TaskTokenUsageSchema, TokenUsageSchema } from '../../schemas/tokens.js';
import { RecoveryIssueSchema } from '../../schemas/recovery/schemas.js';
import {
  ChangedFilesBaselineSchema,
  DiscoveredValidationSchema,
  QueuedMessageSchema,
} from '../../schemas/workflow.js';
import { topoSort } from '../topo-sort.js';

export const LEGACY_STATE_VERSION = 3;
export const LEGACY_DEFAULT_RULE_VERSION = 'brief-quality-v1';
export const LEGACY_DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export const legacyWorkflowStateSchema = z
  .object({
    stateVersion: z.literal(LEGACY_STATE_VERSION),
    phase: PhaseSchema,
    feature: z.string(),
    currentTaskIndex: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    tasks: z.array(TaskSchema),
    plannerSessionId: z.string().nullable().optional(),
    startedAt: z.string(),
    tokenUsage: TokenUsageSchema,
    taskBreakdowns: z.array(TaskTokenUsageSchema).optional(),
    plannerTool: z.string().optional(),
    plannerModel: z.string().optional(),
    implementerTool: z.string().optional(),
    implementerModel: z.string().optional(),
    mode: WorkflowModeSchema.optional(),
    approve: ApproveLevelSchema.optional(),
    selectedSkills: z.array(z.string()).optional(),
    awaitingContinue: z.boolean().default(false),
    budgetPauseAcknowledgedAtCost: z.number().optional(),
    messageQueue: z.array(QueuedMessageSchema).default([]),
    rewindPending: z
      .object({
        target: z.enum(['spec', 'plan']),
        comment: z.string().optional(),
      })
      .optional(),
    changedFilesBaseline: ChangedFilesBaselineSchema.optional(),
    pendingRecovery: RecoveryIssueSchema.optional(),
    discoveredValidation: DiscoveredValidationSchema.optional(),
    external: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((state, ctx) => {
    try {
      topoSort(state.tasks);
    } catch (cause) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: cause instanceof Error ? cause.message : 'Invalid task graph',
      });
    }
    const taskCount = state.tasks.length;
    if (
      (state.phase === 'validating-task' || state.phase === 'escalating') &&
      state.currentTaskIndex >= taskCount
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentTaskIndex'],
        message: 'currentTaskIndex must reference an existing task in active task phases',
      });
    }
    if (taskCount > 0 && state.currentTaskIndex > taskCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentTaskIndex'],
        message: 'currentTaskIndex must not exceed task count',
      });
    }
  });

export type LegacyWorkflowState = z.infer<typeof legacyWorkflowStateSchema>;

export function parseLegacyWorkflowState(value: unknown): LegacyWorkflowState | null {
  const parsed = legacyWorkflowStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const legacyQualityIssueSchema = z
  .object({
    taskId: z.string().nullable(),
    severity: z.enum(['error', 'warning']),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const legacyQualityReportSchema = z
  .object({
    version: z.literal(1),
    passed: z.boolean(),
    score: z.number().finite().min(0).max(1),
    issues: z.array(legacyQualityIssueSchema),
    // A future writer may include this identity. It is not part of the v3
    // report, but accepting it lets migration detect a mismatched artifact
    // rather than silently treating it as a new Brief.
    briefHash: z.string().min(1).optional(),
    ruleVersion: z.string().min(1).optional(),
  })
  .strict();

export type LegacyQualityReport = z.infer<typeof legacyQualityReportSchema>;
