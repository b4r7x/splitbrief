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
  ReviewAnswerSchema,
  ReviewChecksPlanObjectSchema,
  ReviewVerdictSchema,
  TriageInputSchema,
  TriageResultSchema,
} from './review.js';
import { CONSULT_REASONS, CONSULT_SEATS, ConsultAnswerSchema } from './consult.js';
import { TokenUsageSchema, TaskTokenUsageSchema } from './tokens.js';
import { RecoveryIssueSchema, SeatSwapCandidateSchema } from './recovery/schemas.js';
import { StepCutSchema, StepRefSchema } from './run-step.js';
import { CREW_SEAT_IDS } from '../crew/identity.js';
import { topoSort } from '../state/topo-sort.js';
import { lineageIdOf } from '../state/task-insert.js';
import { isRecord } from '../../utils/type-guards.js';
import { ClarificationQuestionSchema } from './question.js';
import { SeatAccountCauseSchema } from '../recovery/account-cause.js';
import { AttachmentSchema, AttachedInputSchema } from './attachment.js';

export const PlannerConversationSchema = z.object({
  call: z.enum(['research', 'spec', 'plan', 'tasks']),
  seat: z.enum(CONSULT_SEATS).optional(),
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

export const QueuedMessageSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    displayText: z.string().optional(),
    images: z.array(AttachmentSchema).default([]),
    attachedInputs: z.array(AttachedInputSchema).default([]),
    queuedAt: z.string(),
    phase: PhaseSchema,
    deliveredViaNative: z.boolean(),
    nativeDeliveryState: z.enum(['pending', 'injecting', 'delivered']).default('pending'),
    possibleDuplicate: z.boolean().optional(),
    deliveredMidCall: z.literal(true).optional(),
    drainedAt: z.string().optional(),
    deliveredTo: z
      .object({
        implementer: z.string().optional(),
        reviewer: z.string().optional(),
      })
      .optional(),
    origin: z.enum(['user-input', 'clarification']).optional(),
    question: z.string().optional(),
  })
  .transform((message) => ({
    ...message,
    displayText: message.displayText ?? message.text,
  }));

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
  // A run workspace's dirty files by hash and mode; their bytes are in the session's entry store.
  storedDirtyEntries: z
    .record(
      z.string(),
      z
        .object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
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
  /** Paths the task changed before returning control; later checkout edits do not grant restore authority. */
  restoreFiles: z.array(z.string()).optional(),
});

export type ChangedFilesSnapshot = z.infer<typeof ChangedFilesSnapshotSchema>;

export const ChangedFilesBaselineSchema = z.object({
  head: z.string().nullable(),
  fingerprints: z.record(z.string(), z.string()),
  runStartChangedFiles: z.array(z.string()).optional(),
  activeTaskSnapshot: ChangedFilesSnapshotSchema.optional(),
});

const TASK_ACTIVE_PHASES = new Set<Phase>(['validating-task', 'escalating']);

export const CONSULT_ACTION_KINDS = [
  'guidance',
  'rewrite-task',
  'split-task',
  'verify',
  'ask-user',
] as const;

export const ConsultRecordSchema = z.object({
  reason: z.enum(CONSULT_REASONS),
  action: z.enum(CONSULT_ACTION_KINDS),
  diagnosis: z.string(),
  at: z.string(),
  taskId: TaskIdSchema,
  revision: z.number().int(),
  answer: ConsultAnswerSchema,
  /** The seat that answered; an older record without one was a planner consult. */
  seat: z.enum(CONSULT_SEATS).optional(),
});
export type ConsultRecord = z.infer<typeof ConsultRecordSchema>;

/**
 * A run saved before decisions went to the ledger kept deviation consults, and a run saved before
 * a brief with moved input files dispatched without a planner call kept stale consults; both load
 * as nothing.
 */
function dropRetiredConsults(value: unknown): unknown {
  return Array.isArray(value)
    ? value.filter(
        (record) =>
          !isRecord(record) ||
          (record.reason !== 'deviation' &&
            record.reason !== 'stale' &&
            record.action !== 'confirm'),
      )
    : value;
}

/** One failed attempt of a lineage: the brief and revision it ran, and its first error line. */
export const AttemptFailureSchema = z.object({
  attempt: z.number().int().positive(),
  taskId: TaskIdSchema,
  revision: z.number().int(),
  line: z.string(),
});
export type AttemptFailure = z.infer<typeof AttemptFailureSchema>;

/** A failure as the progress judgement compares it: each failing source with its failure keys. */
export const FailureMarkSchema = z.array(
  z.object({ source: z.string(), keys: z.array(z.string()) }),
);
export type FailureMark = z.infer<typeof FailureMarkSchema>;

/**
 * The failure the planner saw at its last answer on a lineage, how many answers in a row before
 * that one did not move it, and how many answers the lineage got.
 */
export const LineageProgressSchema = z.object({
  failure: FailureMarkSchema,
  unmoved: nonnegativeInteger,
  answers: nonnegativeInteger,
});
export type LineageProgress = z.infer<typeof LineageProgressSchema>;

export const LineageRecordSchema = z.object({
  attempts: nonnegativeInteger,
  progress: LineageProgressSchema.optional(),
  /** The revision that already dispatched an attempt; a Try again of it runs on its own files. */
  dispatchedRevision: z.record(z.string(), z.number().int()).default({}),
  consultRecords: z.preprocess(dropRetiredConsults, z.array(ConsultRecordSchema)).default([]),
  replacedParents: z.array(TaskSchema).default([]),
  notes: z.array(z.string()).default([]),
  carriedFailure: z.string().optional(),
  corrections: z.array(z.string()).optional(),
  correctionImages: z.array(AttachmentSchema).optional(),
  /** The task start of the lineage's first dispatch; kept only while one of its briefs is open. */
  startSnapshot: ChangedFilesSnapshotSchema.optional(),
  attemptFailures: z.array(AttemptFailureSchema).optional(),
});
export type LineageRecord = z.infer<typeof LineageRecordSchema>;

/** The attempts a task's lineage has spent; a lineage with no record starts fresh. */
export function lineageAttemptsOf(
  state: Pick<WorkflowState, 'lineages'>,
  task: Pick<Task, 'id' | 'parentId'>,
): number {
  return state.lineages?.[lineageIdOf(task)]?.attempts ?? 0;
}

export const FixCyclesSchema = z.object({
  used: nonnegativeInteger,
  notes: z.array(z.string()),
  /** The fix cycle that started and that no review has judged yet, with the id of its last inserted fix task. */
  open: z.object({ cycle: nonnegativeInteger, lastFixTaskId: TaskIdSchema.optional() }).optional(),
});
export type FixCycles = z.infer<typeof FixCyclesSchema>;

export const ReviewRecordSchema = z.object({
  scope: z.enum(['task', 'final']).optional(),
  afterTaskId: TaskIdSchema.optional(),
  cycle: z.number().int(),
  /** The fix cycle this review judges: it compares its blockers with that cycle's triage record. */
  judges: z.number().int().optional(),
  verdict: ReviewVerdictSchema,
  outcome: z.enum(['pass', 'pass-with-notes', 'fail']),
  verification: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['pass', 'fail', 'unverified']),
      output: z.string(),
    }),
  ),
  /** The red check and Apply inputs the answer left blocking; each one fails the review. */
  redInputs: z.array(TriageInputSchema.pick({ id: true, text: true })).optional(),
  /**
   * The reviewer checks of this review that were red at the run base too: each check, its command
   * and the failures that also fail before the run's changes. They raise no finding.
   */
  preExistingChecks: z
    .array(z.object({ id: z.string(), command: z.string(), keys: z.array(z.string()) }))
    .optional(),
  at: z.string(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

/**
 * The reviewer's answer before its verify ends: a continue verifies it instead of asking the
 * reviewer again. The review record replaces it.
 */
export const SavedReviewAnswerSchema = z.object({
  scope: z.enum(['task', 'final']),
  afterTaskId: TaskIdSchema.optional(),
  cycle: z.number().int(),
  answer: ReviewAnswerSchema,
  preExistingChecks: ReviewRecordSchema.shape.preExistingChecks.unwrap(),
  /** The reviewer commands this review's checks ran. */
  discharged: z.array(z.string()),
  /** The reviewer checks' results the cut call read. */
  checksSection: z.string().optional(),
  at: z.string(),
});

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
  /** The keys of the problems that failed the review this answer followed (`blockingKeys`). */
  blocking: z.array(z.string()).optional(),
  /** The kind of that review: it picks the review that judges this cycle (`ReviewRecord.judges`). */
  scope: z.enum(['task', 'final']).optional(),
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

/**
 * The seat a wait holds, by tool and kind, on the BUILD profile it runs on: the runner the waiting
 * call ran on, or the seat the run continues on when the operator chose Retry at. A continue whose
 * config runs that seat on neither this tool nor the runner whose limit the wait waits out does
 * not wait.
 */
export const HeldSeatSchema = z.object({
  tool: z.string(),
  kind: RunnerKindSchema,
  profile: z.string().optional(),
});
export type HeldSeat = z.infer<typeof HeldSeatSchema>;

/**
 * A seat waits for a reset; the runner the halted call ran on, by id, and the seat the wait holds,
 * unless an older state kept none.
 */
export const SeatWaitSchema = z.object({
  seat: z.enum(CREW_SEAT_IDS),
  resetAt: z.string(),
  tool: z.string().optional(),
  kind: RunnerKindSchema.optional(),
  holds: HeldSeatSchema.optional(),
});
export type SeatWait = z.infer<typeof SeatWaitSchema>;

/** A seat moved for a recovery reason, or because the crew changed while the run was stopped. */
export const SeatSwitchCauseSchema = RecoveryReasonSchema.or(z.literal('crew-changed'));
export type SeatSwitchCause = z.infer<typeof SeatSwitchCauseSchema>;

export const SeatSwitchRecordSchema = z.object({
  switchId: z.string().optional(),
  seat: z.enum(CREW_SEAT_IDS),
  from: z.string(),
  to: z.string(),
  fromSeat: SeatSwapCandidateSchema.optional(),
  toSeat: SeatSwapCandidateSchema.optional(),
  cause: RecoveryReasonSchema,
  accountCause: SeatAccountCauseSchema.optional(),
  headline: z.string().optional(),
  auto: z.boolean(),
  configRevision: z.string(),
  ts: z.string(),
});

export type SeatSwitchRecord = z.infer<typeof SeatSwitchRecordSchema>;

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
  reviewAnswer: SavedReviewAnswerSchema.optional(),
  reviewChecks: ReviewChecksRecordSchema.optional(),
  /** Reviewer commands a fix check ran that no review has run since; the next reviewer-checks plan must choose them first. */
  pendingReviewCommands: z.array(z.string()).optional(),
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
       * The declared files the cut brief had changed when the stop parked it. Absent when it had
       * changed none, when the step is no brief, and on a state written before the field.
       */
      kept: z.array(z.string()).optional(),
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
    .object({ at: z.string(), findings: z.array(z.string()), note: z.string().optional() })
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
      notes: [],
    }
  );
}
