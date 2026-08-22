import { z } from 'zod';
import { PhaseSchema, WorkflowModeSchema, ApproveLevelSchema } from './enums.js';
import { TaskSchema } from './task.js';
import { TokenUsageSchema, TaskTokenUsageSchema } from './tokens.js';
import { RecoveryIssueSchema } from './recovery/schemas.js';
import { BriefRecoveryV1Schema } from './brief-recovery.js';
import { BriefGenerationRefSchema, TaskExecutionPermitSchema } from './brief-owner.js';
import { topoSort } from '../state/topo-sort.js';

export const WORKFLOW_STATE_VERSION = 4;

export const StateFenceSchema = z.strictObject({
  token: z.number().int().nonnegative(),
  ownerId: z.string().min(1),
});

export type StateFence = z.infer<typeof StateFenceSchema>;

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

const TASK_ACTIVE_PHASES = new Set(['validating-task', 'escalating']);
const READY_BRIEF_RECOVERY_PHASES = new Set([
  'implementing',
  'validating-task',
  'escalating',
  'final-review',
]);

const WorkflowStateFields = {
  stateVersion: z.literal(WORKFLOW_STATE_VERSION),
  stateRevision: nonnegativeInteger,
  stateFence: StateFenceSchema,
  authorityRevision: nonnegativeInteger.optional(),
  generation: BriefGenerationRefSchema.nullable().optional(),
  permit: TaskExecutionPermitSchema.nullable().optional(),
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
  briefRecovery: z.preprocess(
    (value) => (value === undefined ? null : value),
    BriefRecoveryV1Schema.nullable(),
  ),
};

export const WorkflowStateSchema = z.strictObject(WorkflowStateFields).superRefine((state, ctx) => {
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

  if (state.permit !== undefined && state.permit !== null) {
    if (state.generation === undefined || state.generation === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['permit'],
        message: 'an execution permit requires an authoritative generation',
      });
    }
    if (state.authorityRevision === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorityRevision'],
        message: 'an execution permit requires an authority revision',
      });
    } else if (state.permit.authorityRevision !== state.authorityRevision) {
      ctx.addIssue({
        code: 'custom',
        path: ['permit', 'authorityRevision'],
        message: 'permit authority revision must match workflow authority revision',
      });
    }
    if (state.generation !== undefined && state.generation !== null) {
      if (
        state.permit.generationId !== state.generation.generationId ||
        state.permit.manifestDigest !== state.generation.manifestDigest ||
        state.permit.tasksDigest !== state.generation.tasksDigest ||
        state.permit.qualityDigest !== state.generation.qualityDigest
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['permit'],
          message: 'permit must identify the current generation digests',
        });
      }
    }
    if (state.briefRecovery === undefined || state.briefRecovery === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['briefRecovery'],
        message: 'an execution permit requires ready recovery authority',
      });
    } else {
      if (state.briefRecovery.status !== 'ready') {
        ctx.addIssue({
          code: 'custom',
          path: ['briefRecovery', 'status'],
          message: 'an execution permit requires ready recovery authority',
        });
      }
      if (state.permit.epochId !== state.briefRecovery.epochId) {
        ctx.addIssue({
          code: 'custom',
          path: ['permit', 'epochId'],
          message: 'permit epoch must match the current Brief recovery epoch',
        });
      }
    }
  }

  if (
    state.generation !== undefined &&
    state.generation !== null &&
    state.authorityRevision === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['authorityRevision'],
      message: 'an authoritative generation requires an authority revision',
    });
  }

  const recovery = state.briefRecovery;
  if (recovery === undefined) return;

  if (state.phase === 'reviewing-briefs') {
    if (recovery !== null && recovery.status === 'rejected') {
      ctx.addIssue({
        code: 'custom',
        path: ['briefRecovery', 'status'],
        message: 'rejected Brief archives belong to the idle phase',
      });
    }
  } else if (READY_BRIEF_RECOVERY_PHASES.has(state.phase)) {
    if (recovery !== null && recovery.status !== 'ready') {
      ctx.addIssue({
        code: 'custom',
        path: ['briefRecovery', 'status'],
        message: 'task execution phases require ready Brief recovery authority',
      });
    }
  } else if (state.phase === 'idle') {
    if (recovery !== null && recovery.status !== 'rejected') {
      ctx.addIssue({
        code: 'custom',
        path: ['briefRecovery', 'status'],
        message: 'idle may only retain a rejected Brief archive',
      });
    }
  } else if (recovery !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['briefRecovery'],
      message: 'Brief recovery is scoped to reviewing-briefs or an idle rejected archive',
    });
  }
});

export type PersistedWorkflowState = z.infer<typeof WorkflowStateSchema>;

// WorkflowState is also used while a workflow is being assembled in memory.
// The persisted boundary above remains strict v4; these optional fields keep
// pre-persistence construction assignable without weakening that boundary.
export type WorkflowStateAssembly = Omit<
  PersistedWorkflowState,
  'stateVersion' | 'stateRevision' | 'stateFence' | 'briefRecovery'
> & {
  stateVersion: number;
  stateRevision?: number;
  stateFence?: StateFence;
  briefRecovery?: PersistedWorkflowState['briefRecovery'];
};
export type WorkflowState = WorkflowStateAssembly;
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
export type PersistedChangedFilesBaseline = z.infer<typeof ChangedFilesBaselineSchema>;
