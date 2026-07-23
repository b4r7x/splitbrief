import { z } from 'zod';
import { PhaseSchema, WorkflowModeSchema, ApproveLevelSchema } from './enums.js';
import { TaskSchema } from './task.js';
import { TokenUsageSchema, TaskTokenUsageSchema } from './tokens.js';
import { RecoveryIssueSchema } from './recovery/schemas.js';
import { topoSort } from '../state/topo-sort.js';

export const DiscoveredValidationSchema = z.object({
  typecheckCommand: z.string().optional(),
  lintCommand: z.string().optional(),
  testCommand: z.string().optional(),
  testPattern: z.string().optional(),
  language: z.string().optional(),
});

export type DiscoveredValidation = z.infer<typeof DiscoveredValidationSchema>;

export const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  queuedAt: z.string(),
  phase: PhaseSchema,
  deliveredViaNative: z.boolean(),
  nativeDeliveryState: z.enum(['pending', 'injecting', 'delivered']).default('pending'),
  drainedAt: z.string().optional(),
  origin: z.enum(['user-input', 'clarification']).optional(),
  question: z.string().optional(),
});

export const ChangedFilesBaselineSchema = z.object({
  head: z.string().nullable(),
  fingerprints: z.record(z.string(), z.string()),
  activeTaskSnapshot: z
    .object({
      head: z.string(),
      files: z.array(z.string()),
      dirtyFileContents: z.record(z.string(), z.string().nullable()),
      gitlinks: z.array(z.string()).optional(),
      baselineFileHashes: z.record(z.string(), z.string().nullable()).optional(),
      ignoreProjectDir: z.string().optional(),
    })
    .optional(),
});

const TASK_ACTIVE_PHASES = new Set(['validating-task', 'escalating']);

export const WorkflowStateSchema = z
  .object({
    stateVersion: z.number(),
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
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: err instanceof Error ? err.message : 'Invalid task graph',
      });
    }

    const taskCount = state.tasks.length;
    if (taskCount === 0) return;

    if (TASK_ACTIVE_PHASES.has(state.phase)) {
      if (state.currentTaskIndex >= taskCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['currentTaskIndex'],
          message: 'currentTaskIndex must reference an existing task in active task phases',
        });
      }
      return;
    }

    if (state.currentTaskIndex > taskCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentTaskIndex'],
        message: 'currentTaskIndex must not exceed task count',
      });
    }
  });

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
export type PersistedChangedFilesBaseline = z.infer<typeof ChangedFilesBaselineSchema>;
