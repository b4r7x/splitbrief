import { z } from 'zod';
import {
  PhaseSchema,
  RunnerKindSchema,
  WorkflowModeSchema,
  ApproveLevelSchema,
  REVIEW_STATUSES,
  ValidationStageSchema,
  type Phase,
} from './enums.js';
import { TaskSchema } from './task.js';
import { TokenUsageSchema, TaskTokenUsageSchema } from './tokens.js';
import { RecoveryIssueSchema } from './recovery/schemas.js';
import { StepCutSchema, StepRefSchema } from './run-step.js';
import { topoSort } from '../state/topo-sort.js';
import { isRecord } from '../../utils/type-guards.js';
import { ClarificationQuestionSchema } from './question.js';

export const PlannerConversationSchema = z.object({
  call: z.enum(['research', 'spec', 'plan', 'tasks']),
  text: z.string(),
  questions: z.array(ClarificationQuestionSchema),
  answers: z.array(z.object({ reply: z.string(), answer: z.string() })),
  answered: z.boolean().default(false),
});
export type PlannerConversation = z.infer<typeof PlannerConversationSchema>;

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

export const ValidationBaselineSchema = z.object({
  failingStages: z.array(ValidationStageSchema),
  commands: z.partialRecord(ValidationStageSchema, z.string()),
  failures: z.partialRecord(ValidationStageSchema, z.array(z.string())),
});

export type PersistedValidationBaseline = z.infer<typeof ValidationBaselineSchema>;

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
  // Fresh snapshots retain exact bytes and modes; legacy text snapshots still load.
  dirtyFileEntries: z
    .record(
      z.string(),
      z
        .object({
          base64: z.string(),
          mode: z.number().int().min(0).max(0o777),
        })
        .nullable(),
    )
    .optional(),
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
  // The `@file` text the run was started with: the planner reads it on every call, so a
  // continue that has no runtime copy of it restores this one.
  plannerContext: z.string().optional(),
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
  plannerKind: RunnerKindSchema.optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  implementerKind: RunnerKindSchema.optional(),
  reviewerTool: z.string().optional(),
  reviewerModel: z.string().optional(),
  reviewerKind: RunnerKindSchema.optional(),
  mode: WorkflowModeSchema.optional(),
  approve: ApproveLevelSchema.optional(),
  selectedSkills: z.array(z.string()).optional(),
  awaitingContinue: z.boolean().default(false),
  messageQueue: z.array(QueuedMessageSchema).default([]),
  rewindPending: z
    .object({
      target: z.enum(['spec', 'plan']),
      comment: z.string().optional(),
    })
    .optional(),
  changedFilesBaseline: ChangedFilesBaselineSchema.optional(),
  pendingRecovery: RecoveryIssueSchema.optional(),
  pendingPlannerConversation: PlannerConversationSchema.optional(),
  discoveredValidation: DiscoveredValidationSchema.optional(),
  validationBaseline: ValidationBaselineSchema.optional(),
  reviewFixes: z
    .object({
      cycle: z.number().int(),
      findings: z.record(z.string(), z.array(z.string())),
    })
    .optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  interruptedStep: z
    .object({
      step: StepRefSchema,
      source: z.enum(['user', 'watchdog']),
      cut: StepCutSchema.optional(),
      partialRef: z.object({ kind: z.literal('session-log'), index: z.number().int() }).optional(),
      at: z.string(),
    })
    .optional(),
  closed: z.object({ at: z.string(), as: z.literal('ended') }).optional(),
  lastFailure: z.object({ step: StepRefSchema, message: z.string(), at: z.string() }).optional(),
  external: z.record(z.string(), z.unknown()).optional(),
};

const LEGACY_STATE_KEYS = [
  'stateFence',
  'authorityRevision',
  'generation',
  'permit',
  'briefRecovery',
  'budgetPauseAcknowledgedAtCost',
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
