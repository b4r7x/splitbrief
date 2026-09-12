import { z } from 'zod';
import { PhaseSchema, WorkflowModeSchema, ApproveLevelSchema, type Phase } from './enums.js';
import { TaskSchema } from './task.js';
import { TokenUsageSchema, TaskTokenUsageSchema } from './tokens.js';
import { RecoveryIssueSchema } from './recovery/schemas.js';
import { topoSort } from '../state/topo-sort.js';
import { isRecord } from '../../utils/type-guards.js';

export const WORKFLOW_STATE_VERSION = 4;

const nonnegativeInteger = z.number().int().nonnegative();

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

export const ChangedFilesSnapshotSchema = z.object({
  head: z.string(),
  files: z.array(z.string()),
  dirtyFileContents: z.record(z.string(), z.string().nullable()),
  gitlinks: z.array(z.string()).optional(),
  baselineFileHashes: z.record(z.string(), z.string().nullable()).optional(),
  ignoreProjectDir: z.string().optional(),
});

export type ChangedFilesSnapshot = z.infer<typeof ChangedFilesSnapshotSchema>;

export const ChangedFilesBaselineSchema = z.object({
  head: z.string().nullable(),
  fingerprints: z.record(z.string(), z.string()),
  runStartChangedFiles: z.array(z.string()).optional(),
  activeTaskSnapshot: ChangedFilesSnapshotSchema.optional(),
});

const TASK_ACTIVE_PHASES = new Set<Phase>(['validating-task', 'escalating']);

const WorkflowStateFields = {
  stateVersion: z.literal(WORKFLOW_STATE_VERSION),
  stateRevision: nonnegativeInteger,
  phase: PhaseSchema,
  feature: z.string(),
  currentTaskIndex: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  tasks: z.array(TaskSchema),
  plannerSessionId: z.string().nullable().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  tokenUsage: TokenUsageSchema,
  taskBreakdowns: z.array(TaskTokenUsageSchema).optional(),
  plannerTool: z.string().optional(),
  plannerModel: z.string().optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  reviewerTool: z.string().optional(),
  reviewerModel: z.string().optional(),
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
};

const LEGACY_STATE_KEYS = [
  'stateFence',
  'authorityRevision',
  'generation',
  'permit',
  'briefRecovery',
] as const;

function stripLegacyStateKeys(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const record: Record<string, unknown> = { ...value };
  for (const key of LEGACY_STATE_KEYS) delete record[key];
  return record;
}

const WorkflowStateCoreSchema = z.strictObject(WorkflowStateFields).superRefine((state, ctx) => {
  try {
    topoSort(state.tasks);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      path: ['tasks'],
      message: err instanceof Error ? err.message : 'Invalid task graph',
    });
  }

  if (TASK_ACTIVE_PHASES.has(state.phase)) {
    const taskCount = state.tasks.length;
    if (state.currentTaskIndex >= taskCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentTaskIndex'],
        message: 'currentTaskIndex must reference an existing task in active task phases',
      });
    }
  } else {
    const taskCount = state.tasks.length;
    if (taskCount > 0 && state.currentTaskIndex > taskCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentTaskIndex'],
        message: 'currentTaskIndex must not exceed task count',
      });
    }
  }
});

export const WorkflowStateSchema = z.preprocess(stripLegacyStateKeys, WorkflowStateCoreSchema);

export type PersistedWorkflowState = z.infer<typeof WorkflowStateSchema>;

// WorkflowState is also used while a workflow is being assembled in memory.
// The persisted boundary above remains strict v4; these optional fields keep
// pre-persistence construction assignable without weakening that boundary.
export type WorkflowStateAssembly = Omit<
  PersistedWorkflowState,
  'stateVersion' | 'stateRevision'
> & {
  stateVersion: number;
  stateRevision?: number;
};
export type WorkflowState = WorkflowStateAssembly;
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
export type PersistedChangedFilesBaseline = z.infer<typeof ChangedFilesBaselineSchema>;
