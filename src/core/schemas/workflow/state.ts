import { z } from 'zod';
import { isRecord } from '../../../utils/type-guards.js';
import { topoSort } from '../../state/topo-sort.js';
import { ConsultQuestionSchema } from '../consult.js';
import {
  type Phase,
  PhaseSchema,
  RunnerKindSchema,
  WorkflowModeSchema,
  ApproveLevelSchema,
  REVIEW_STATUSES,
} from '../enums.js';
import { PlanSchema } from '../plan.js';
import { ClarificationQuestionSchema } from '../question.js';
import { RecoveryIssueSchema } from '../recovery/schemas.js';
import { StepRefSchema, StepCutSchema } from '../run-step.js';
import { TaskSchema, TaskIdSchema } from '../task.js';
import { TokenUsageSchema, TaskTokenUsageSchema } from '../tokens.js';
import { ChangedFilesBaselineSchema } from './changed-files.js';
import { nonnegativeInteger } from './consult-record.js';
import { DiscoveredValidationSchema } from './discovered-validation.js';
import { LineageRecordSchema } from './lineage.js';
import { QueuedMessageSchema } from './queue.js';
import {
  FixCyclesSchema,
  ReviewRecordSchema,
  TriageRecordSchema,
  PendingTriageSchema,
  RedCheckSchema,
} from './review-record.js';
import { SeatWaitSchema, SeatSwitchRecordSchema } from './seat.js';

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

const TASK_ACTIVE_PHASES = new Set<Phase>(['validating-task', 'escalating']);

const ApplyIntegratedSchema = z.object({
  path: z.string(),
  checkout: z.string(),
  workspace: z.string().nullable(),
});

/**
 * A record saved before `workspace` is bound to no resolution, so it loads as nothing and that
 * file merges again.
 */
function dropUnboundRecords(value: unknown): unknown {
  return Array.isArray(value)
    ? value.filter((record) => isRecord(record) && 'workspace' in record)
    : value;
}

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
  /** REVIEW was None when the run started, so no seat reviews it. */
  reviewerSeat: z.literal('none').optional(),
  mode: WorkflowModeSchema.optional(),
  approve: ApproveLevelSchema.optional(),
  selectedSkills: z.array(z.string()).optional(),
  awaitingContinue: z.boolean().default(false),
  messageQueue: z.array(QueuedMessageSchema).default([]),
  resumeUserMessages: z
    .array(
      z
        .object({
          ts: z.string(),
          phase: PhaseSchema,
          displayText: z.string(),
        })
        .and(
          z.union([
            z.object({ text: z.string() }),
            z.object({ answerIndex: z.number().int().nonnegative() }),
          ]),
        ),
    )
    .optional(),
  lineages: z.record(z.string(), LineageRecordSchema).optional(),
  userAnswers: PlannerConversationSchema.shape.answers.optional(),
  seatWait: SeatWaitSchema.optional(),
  /** The user chose Decide for me: the run asks nothing more and takes each decided step itself. */
  decideForMe: z.literal(true).optional(),
  seatSwitches: z.array(SeatSwitchRecordSchema).optional(),
  /** The BUILD profile a recovery action keeps the brief on until that brief settles. */
  retryProfile: z.object({ taskId: TaskIdSchema, profile: z.string() }).optional(),
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
      /**
       * The files the cut brief wrote that are still changed when the stop parked it, its declared
       * files first. Absent when it kept none, when the step is no brief, and on a state written
       * before the field.
       */
      kept: z.array(z.string()).optional(),
      /**
       * The brief's attempt ended and its consult call stopped on a seat that cannot run: the run
       * continues with that consult, on the files the attempt left, not with a BUILD call. It holds
       * the question that consult was asked, so the consult that runs again asks it too.
       */
      consult: ConsultQuestionSchema.optional(),
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
  acceptedAsIs: z
    .object({
      at: z.string(),
      findings: z.array(z.string()),
      /** The red checks your accept left red. Absent when it left none, and on an older run. */
      redChecks: z.array(RedCheckSchema).optional(),
      note: z.string().optional(),
      /** The planner accepted a stuck review's blockers; without it, you did. */
      by: z.literal('planner').optional(),
    })
    .optional(),
  /** The run diff of the workspace the last final review judged: path → entry key. */
  reviewedCandidate: z.record(z.string(), z.string()).optional(),
  /** Set while an integration review runs after Apply changed the candidate. */
  applyReview: z
    .object({
      merged: z.array(z.object({ path: z.string(), checkoutHunks: z.string() })),
      failures: z.array(z.string()),
      /** The re-run checks that did not run to a result; the review reads them beside the failures. */
      notRun: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Each conflicted file Apply handed to the workspace, with the checkout entry it saw then and the
   * workspace entry the user resolved it to, `null` until the resolution is taken (`entryKey`:
   * `absent`, `file:<sha256>:<octal mode>` or `symlink:<target>`).
   */
  applyIntegrated: z.preprocess(dropUnboundRecords, z.array(ApplyIntegratedSchema)).optional(),
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
  'decisionConfirms',
  'plannerCalls',
  'reviewChecks',
  'pendingReviewCommands',
  'reviewAnswer',
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
