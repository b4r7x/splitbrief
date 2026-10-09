import { z } from 'zod';
import {
  PhaseSchema,
  RecoveryReasonSchema,
  RunnerKindSchema,
  WorkflowModeSchema,
  ApproveLevelSchema,
  REVIEW_STATUSES,
  type Phase,
} from './enums.js';
import { TaskSchema, TaskIdSchema, type Task } from './task.js';
import { PlanSchema } from './plan.js';
import {
  ReviewChecksPlanObjectSchema,
  ReviewVerdictSchema,
  TriageInputSchema,
  TriageResultSchema,
} from './review.js';
import { REVIEW_CYCLE_CAP } from '../pipeline-spec/review.js';
import { BOUNDS } from '../pipeline-spec/bounds.js';
import { CONSULT_REASONS, ConsultAnswerSchema } from './consult.js';
import { TokenUsageSchema, TaskTokenUsageSchema } from './tokens.js';
import { RecoveryIssueSchema } from './recovery/schemas.js';
import { StepCutSchema, StepRefSchema } from './run-step.js';
import { CREW_SEAT_IDS } from '../crew/identity.js';
import { topoSort } from '../state/topo-sort.js';
import { lineageIdOf } from '../state/task-insert.js';
import { isRecord } from '../../utils/type-guards.js';
import { ClarificationQuestionSchema } from './question.js';

export const PlannerConversationSchema = z.object({
  call: z.enum(['research', 'spec', 'plan', 'tasks']),
  text: z.string(),
  questions: z.array(ClarificationQuestionSchema),
  answers: z.array(z.object({ reply: z.string(), answer: z.string() })),
  answered: z.boolean().default(false),
  /** What the user asked of the planning session these questions belong to (a plan-card correction). */
  lead: z.string().optional(),
});
export type PlannerConversation = z.infer<typeof PlannerConversationSchema>;

export const WORKFLOW_STATE_VERSION = 4;

const nonnegativeInteger = z.number().int().nonnegative();

export const DiscoveredValidationSchema = z.object({
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
  deliveredTo: z
    .object({
      implementer: z.string().optional(),
      consult: z.string().optional(),
      reviewer: z.string().optional(),
    })
    .optional(),
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
  // Symlinks that stay inside the project, by path: recorded by target, never read through.
  symlinks: z.record(z.string(), z.string()).optional(),
  baselineFileHashes: z.record(z.string(), z.string().nullable()).optional(),
  baselineFileModes: z.record(z.string(), z.number().int().min(0).max(0o777)).optional(),
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

const CONSULT_ACTION_KINDS = [
  'guidance',
  'rewrite-task',
  'split-task',
  'verify',
  'ask-user',
  'confirm',
] as const;

export const ConsultRecordSchema = z.object({
  reason: z.enum(CONSULT_REASONS),
  action: z.enum(CONSULT_ACTION_KINDS),
  diagnosis: z.string(),
  at: z.string(),
  taskId: TaskIdSchema,
  revision: z.number().int(),
  answer: ConsultAnswerSchema,
});
export type ConsultRecord = z.infer<typeof ConsultRecordSchema>;

export const LineageRecordSchema = z.object({
  consults: nonnegativeInteger,
  attempts: nonnegativeInteger,
  consultAllowance: nonnegativeInteger,
  attemptAllowance: nonnegativeInteger,
  staleConsultedRevision: z.record(z.string(), z.number().int()).default({}),
  consultRecords: z.array(ConsultRecordSchema).default([]),
  replacedParents: z.array(TaskSchema).default([]),
  notes: z.array(z.string()).default([]),
  carriedFailure: z.string().optional(),
  corrections: z.array(z.string()).optional(),
});
export type LineageRecord = z.infer<typeof LineageRecordSchema>;

export const PlannerCallsSchema = z.object({
  used: nonnegativeInteger,
  allowance: nonnegativeInteger,
});
export type PlannerCalls = z.infer<typeof PlannerCallsSchema>;

export function plannerCallsOf(state: Pick<WorkflowState, 'plannerCalls'>): PlannerCalls {
  return state.plannerCalls ?? { used: 0, allowance: BOUNDS.plannerCallsPerRun };
}

/** The attempts a task's lineage has spent and may spend; a lineage with no record starts fresh. */
export function lineageAttemptsOf(
  state: Pick<WorkflowState, 'lineages'>,
  task: Pick<Task, 'id' | 'parentId'>,
): { used: number; allowance: number } {
  const lineage = state.lineages?.[lineageIdOf(task)];
  return {
    used: lineage?.attempts ?? 0,
    allowance: lineage?.attemptAllowance ?? BOUNDS.attemptsPerLineage,
  };
}

export const FixCyclesSchema = z.object({
  used: nonnegativeInteger,
  allowance: nonnegativeInteger,
  notes: z.array(z.string()),
});
export type FixCycles = z.infer<typeof FixCyclesSchema>;

export const ReviewRecordSchema = z.object({
  scope: z.enum(['task', 'final']).optional(),
  afterTaskId: TaskIdSchema.optional(),
  cycle: z.number().int(),
  verdict: ReviewVerdictSchema,
  outcome: z.enum(['pass', 'pass-with-notes', 'fail']),
  verification: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['pass', 'fail', 'unverified']),
      output: z.string(),
    }),
  ),
  at: z.string(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

/** The commands the reviewer chose for one review: they are checks `V1…` until the next review chooses again. */
export const ReviewChecksRecordSchema = z.object({
  scope: z.enum(['task', 'final']),
  cycle: z.number().int(),
  plan: ReviewChecksPlanObjectSchema,
  at: z.string(),
  /** None of the chosen commands ran: the user skipped them, or the run had no screen to ask on. */
  skipped: z.object({ reason: z.string() }).optional(),
});
export type ReviewChecksRecord = z.infer<typeof ReviewChecksRecordSchema>;

export const TriageRecordSchema = z.object({
  reviewAt: z.string().optional(),
  cycle: z.number().int(),
  at: z.string(),
  inputIds: z.array(z.string()),
  result: TriageResultSchema,
  /** The plan checks the triage's verify entries named, run before any fix. */
  verification: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(['pass', 'fail', 'unverified']),
        output: z.string(),
      }),
    )
    .optional(),
});
export type TriageRecord = z.infer<typeof TriageRecordSchema>;

export const PendingTriageSchema = z.object({
  inputs: z.array(TriageInputSchema),
  question: TriageResultSchema.shape.ask.optional(),
  reviewAfterTaskId: TaskIdSchema.optional(),
});

export const SeatWaitSchema = z.object({
  seat: z.enum(CREW_SEAT_IDS),
  resetAt: z.string(),
});

export const SeatSwitchRecordSchema = z.object({
  seat: z.enum(CREW_SEAT_IDS),
  from: z.string(),
  to: z.string(),
  cause: RecoveryReasonSchema,
  auto: z.boolean(),
  configRevision: z.string(),
  ts: z.string(),
});

export type SeatSwitchRecord = z.infer<typeof SeatSwitchRecordSchema>;

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
  lineages: z.record(z.string(), LineageRecordSchema).optional(),
  plannerCalls: PlannerCallsSchema.optional(),
  // Read and ignore this field for old sessions.
  decisionConfirms: PlannerCallsSchema.optional(),
  userAnswers: PlannerConversationSchema.shape.answers.optional(),
  seatWait: SeatWaitSchema.optional(),
  seatSwitches: z.array(SeatSwitchRecordSchema).optional(),
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
  plan: PlanSchema.optional(),
  reviewFixes: z
    .object({
      cycle: z.number().int(),
      findings: z.record(z.string(), z.array(z.string())),
    })
    .optional(),
  fixCycles: FixCyclesSchema.optional(),
  review: ReviewRecordSchema.optional(),
  reviewChecks: ReviewChecksRecordSchema.optional(),
  triage: z.array(TriageRecordSchema).optional(),
  pendingTriage: PendingTriageSchema.optional(),
  pendingScheduledReview: z.object({ afterTaskId: TaskIdSchema }).optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  interruptedStep: z
    .object({
      step: StepRefSchema,
      source: z.enum(['user', 'watchdog', 'seat']),
      cut: StepCutSchema.optional(),
      partialRef: z.object({ kind: z.literal('session-log'), index: z.number().int() }).optional(),
      at: z.string(),
    })
    .optional(),
  workspace: z
    .object({
      kind: z.enum(['worktree', 'staged-copy', 'checkout']),
      path: z.string(),
      base: z.object({ snapshotId: z.string(), head: z.string().nullable() }),
    })
    .optional(),
  applying: z.object({ at: z.string(), backupId: z.string() }).optional(),
  applied: z
    .object({
      at: z.string(),
      backupId: z.string(),
      files: z.array(z.string()),
      /** Undo put the checkout back from the backup; `conflicts` are the files it left as you changed them. */
      undone: z.object({ at: z.string(), conflicts: z.array(z.string()) }).optional(),
    })
    .optional(),
  acceptedAsIs: z.object({ at: z.string(), findings: z.array(z.string()) }).optional(),
  /** The run diff of the workspace the last final review judged: path → entry key. */
  reviewedCandidate: z.record(z.string(), z.string()).optional(),
  /** Set while an integration review runs after Apply changed the candidate. */
  applyReview: z
    .object({
      merged: z.array(z.object({ path: z.string(), checkoutHunks: z.string() })),
      failures: z.array(z.string()),
    })
    .optional(),
  /** The checkout hash Apply recorded for each text conflict whose markers it wrote into the workspace. */
  applyIntegrated: z.array(z.object({ path: z.string(), checkoutHash: z.string() })).optional(),
  closed: z
    .object({
      at: z.string(),
      as: z.enum(['ended', 'applied', 'discarded']),
      /** The project-relative run.patch the close saved the workspace changes in. */
      patch: z.string().optional(),
    })
    .optional(),
  lastFailure: z.object({ step: StepRefSchema, message: z.string(), at: z.string() }).optional(),
  external: z.record(z.string(), z.unknown()).optional(),
};

const LEGACY_STATE_KEYS = [
  'fullSuiteBaseline',
  'fullSuiteBaselineStages',
  'validationBaseline',
  'pendingBoundary',
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

export function fixCyclesOf(state: Pick<WorkflowState, 'fixCycles' | 'reviewFixes'>): FixCycles {
  return (
    state.fixCycles ?? {
      used: state.reviewFixes?.cycle ?? 0,
      allowance: REVIEW_CYCLE_CAP,
      notes: [],
    }
  );
}
