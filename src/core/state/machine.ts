import { fixBriefDescription } from '../review/fix-task.js';
import { awaitsApply, deriveRunStatus } from '../sessions/run-status.js';
import type { MachineAction, StateAction } from './types.js';
import {
  WORKFLOW_STATE_VERSION,
  fixCyclesOf,
  plannerCallsOf,
  type ConsultRecord,
  type FixCycles,
  type LineageRecord,
  type ReviewRecord,
  type WorkflowState,
} from '../schemas/workflow.js';
import { isTaskCompleted, isTaskSettled, type Task, type TaskId } from '../schemas/task.js';
import type { TriageInput } from '../schemas/review.js';
import type { ReportedDecision } from '../schemas/consult.js';
import type { Phase, TaskStatus } from '../schemas/enums.js';
import { ZERO_TOKEN_USAGE } from '../schemas/tokens.js';
import { isQueuedMessageClearable, isQueuedMessagePendingDelivery } from '../queue-state.js';
import { taskStatusForCompletionMethod } from '../task-completion.js';
import { assertNever } from '../../utils/type-guards.js';
import { includes } from '../../utils/type-guards.js';
import { DEFAULT_LOCAL_RETRIES } from '../pipeline-spec/retries.js';
import { BOUNDS } from '../pipeline-spec/bounds.js';
import { insertTasksAfter, lineageIdOf } from './task-insert.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../scope/declared-set.js';
import { transitionError } from './errors.js';
import { truncateByChars } from '../../utils/truncate.js';

/** The text a reported implementer decision contributes to the plan ledger. */
export function decisionLedgerText(decision: ReportedDecision): string {
  return decision.why === null ? decision.what : `${decision.what} — ${decision.why}`;
}

const anytimeActions = [
  'CLOSE_RUN',
  'RECORD_WORKSPACE',
  'INTERRUPT_STEP',
  'RESUME_STEP',
  'RECORD_REJECT',
  'RESTORE_BRIEF_PARK',
  'SET_PLANNER_CONVERSATION',
  'CLEAR_PLANNER_CONVERSATION',
  'SET_PLANNER_SESSION_ID',
  'ENQUEUE_USER_MSG',
  'MARK_INJECTING_NATIVE',
  'MARK_DELIVERED_NATIVE',
  'MARK_NATIVE_DELIVERY_FAILED',
  'MARK_POSSIBLE_DUPLICATE',
  'DRAIN_QUEUE',
  'CLEAR_QUEUE',
  'SET_PENDING_RECOVERY',
  'MARK_RECOVERY_APPLYING',
  'RESOLVE_PENDING_RECOVERY',
  'RESTART_ATTEMPT_ON_SEAT',
  'RECORD_SEAT_SWITCH',
  'REPLACE_TASK',
  'INSERT_TASKS',
  'RECORD_CONSULT',
  'RECORD_DECISIONS',
  'RECORD_CORRECTION',
  'COUNT_ATTEMPT',
  'COUNT_PLANNER_CALL',
  'CLEAR_CARRIED_FAILURE',
  'GRANT_ALLOWANCE',
  'SET_TASK_INPUT_HASHES',
  'RECORD_DISPATCH',
  'RECORD_CHECK_RESULTS',
  'SET_PENDING_REVIEW_COMMANDS',
  'SET_SEAT_WAIT',
  'CLEAR_SEAT_WAIT',
  'START_SCHEDULED_REVIEW',
  'CLEAR_SCHEDULED_REVIEW',
] as const satisfies readonly MachineAction['type'][];

const VALIDATION_OR_ESCALATION_SHARED_ACTIONS = [
  'VALIDATION_PASS',
  'SKIP_TASK',
  'RESET_TASK',
] as const satisfies readonly MachineAction['type'][];

const phaseActions = {
  idle: ['START', 'BEGIN_PLANNING'],
  researching: ['PLAN_DONE', 'BEGIN_PLANNING'],
  specifying: ['PLAN_DONE', 'BEGIN_PLANNING'],
  'reviewing-spec': ['PLAN_DONE', 'BEGIN_PLANNING'],
  clarifying: ['BEGIN_PLANNING'],
  'constitution-check': ['BEGIN_PLANNING'],
  planning: ['PLAN_DONE', 'PLAN_COMPILED', 'BEGIN_IMPLEMENTATION'],
  'reviewing-plan': [
    'CORRECT_PLAN',
    'PLAN_DONE',
    'PLAN_COMPILED',
    'BEGIN_IMPLEMENTATION',
    'BEGIN_PLANNING',
  ],
  'reviewing-briefs': ['BEGIN_IMPLEMENTATION', 'BEGIN_PLANNING'],
  analyzing: ['PLAN_DONE', 'BEGIN_PLANNING'],
  implementing: [
    'START_TASK',
    'UPDATE_TASK_CODE',
    'TASK_SENT',
    'VALIDATION_PASS',
    'SKIP_TASK',
    'RESET_TASK',
    'ALL_DONE',
    'REVIEW_DONE',
    'RECORD_REVIEW',
    'SAVE_REVIEW_ANSWER',
    'DROP_REVIEW_ANSWER',
    'RECORD_REVIEW_CHECKS',
    'RECORD_TRIAGE',
    'START_FIX_CYCLE',
    'REVIEW_CORRECTION',
    'QUEUE_TRIAGE',
    'ACCEPT_AS_IS',
  ],
  'validating-task': [
    ...VALIDATION_OR_ESCALATION_SHARED_ACTIONS,
    'RESUME_TASK',
    'VALIDATION_FAIL',
    'ESCALATE',
  ],
  escalating: [...VALIDATION_OR_ESCALATION_SHARED_ACTIONS, 'UPDATE_TASK_CODE'],
  'final-review': [
    'REVIEW_DONE',
    'REVIEW_CORRECTION',
    'RECORD_APPLY_RECHECK',
    'BIND_APPLY_INTEGRATED',
    'RECORD_REVIEW',
    'SAVE_REVIEW_ANSWER',
    'DROP_REVIEW_ANSWER',
    'RECORD_REVIEW_CHECKS',
    'RECORD_TRIAGE',
    'START_FIX_CYCLE',
    'QUEUE_TRIAGE',
  ],
  complete: [
    'START_FIX_CYCLE',
    'REVIEW_CORRECTION',
    'RECORD_TRIAGE',
    'QUEUE_TRIAGE',
    'ACCEPT_AS_IS',
    'APPLY_REVIEW_START',
    'RECORD_APPLY_INTEGRATED',
    'BIND_APPLY_INTEGRATED',
    'APPLY_START',
    'APPLY_DONE',
    'APPLY_RESTORED',
    'APPLY_UNDONE',
  ],
} as const satisfies Record<Phase, readonly MachineAction['type'][]>;

/**
 * The review that judges a fix cycle: the next final review for a final review's cycle, the task
 * review after its last inserted fix task for a task review's cycle.
 */
function judgesCycle(
  triage: WorkflowState['triage'],
  open: NonNullable<FixCycles['open']>,
  review: ReviewRecord,
): boolean {
  const started = triage?.findLast((record) => record.cycle === open.cycle);
  if (started?.scope === 'final') return review.scope !== 'task';
  return (
    started?.scope === 'task' &&
    open.lastFixTaskId !== undefined &&
    review.scope === 'task' &&
    review.afterTaskId === open.lastFixTaskId
  );
}

function canApplyAction(phase: Phase, action: MachineAction['type']): boolean {
  return includes(anytimeActions, action) || includes(phaseActions[phase], action);
}

export function createInitialState(feature: string, now: Date = new Date()): WorkflowState {
  return {
    stateVersion: WORKFLOW_STATE_VERSION,
    stateRevision: 0,
    phase: 'idle',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: now.toISOString(),
    tokenUsage: { ...ZERO_TOKEN_USAGE },
    awaitingContinue: false,
    messageQueue: [],
  };
}

/** A brief's recovery pin ends when the brief settles: until then every route of it reads the pin. */
function setTaskStatus(state: WorkflowState, taskId: TaskId, status: TaskStatus): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
    ...(state.retryProfile?.taskId === taskId &&
      isTaskSettled(status) && { retryProfile: undefined }),
  };
}

const EMPTY_LINEAGE: LineageRecord = {
  consults: 0,
  attempts: 0,
  consultAllowance: BOUNDS.consultsPerLineage,
  attemptAllowance: BOUNDS.attemptsPerLineage,
  staleConsultedRevision: {},
  dispatchedRevision: {},
  consultRecords: [],
  replacedParents: [],
  notes: [],
};

export function lineageKeyFor(state: WorkflowState, taskId: TaskId): TaskId {
  const task = state.tasks.find((t) => t.id === taskId);
  return task === undefined ? taskId : lineageIdOf(task);
}

export function briefCorrections(state: WorkflowState, taskId: TaskId): readonly string[] {
  return state.lineages?.[lineageKeyFor(state, taskId)]?.corrections ?? [];
}

function withLineage(
  state: WorkflowState,
  key: TaskId,
  update: (lineage: LineageRecord) => LineageRecord,
): WorkflowState {
  const lineages = state.lineages ?? {};
  return {
    ...state,
    lineages: { ...lineages, [key]: update(lineages[key] ?? EMPTY_LINEAGE) },
  };
}

/** Whether a brief of the lineage `key`, other than `exceptId`, is still open. */
export function lineageHasOpenBrief(
  tasks: readonly Task[],
  key: TaskId,
  exceptId?: TaskId,
): boolean {
  return tasks.some((t) => lineageIdOf(t) === key && t.id !== exceptId && !isTaskSettled(t.status));
}

/**
 * The files of a lineage's `unbooked` changes that a settling brief books: the ones its declared
 * set names, or every one when it closes the lineage. A file two briefs name goes to the first to
 * settle, because it is booked from then on.
 */
export function lineageFilesToBook(
  brief: Task,
  closesLineage: boolean,
  unbooked: readonly string[],
): string[] {
  if (closesLineage) return [...unbooked];
  const declared = taskDeclaredPatterns(brief);
  return unbooked.filter((file) => isInDeclaredSet(file, declared));
}

/** A lineage keeps its task start only while one of its briefs is still open. */
function dropClosedLineageStart(state: WorkflowState, taskId: TaskId): WorkflowState {
  const key = lineageKeyFor(state, taskId);
  const lineage = state.lineages?.[key];
  if (lineage?.startSnapshot === undefined) return state;
  if (lineageHasOpenBrief(state.tasks, key)) return state;
  const { startSnapshot: _closedStart, ...closed } = lineage;
  return { ...state, lineages: { ...state.lineages, [key]: closed } };
}

function stripCurrentCode(state: WorkflowState, taskId: TaskId): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map((t) => {
      if (t.id !== taskId) return t;
      const {
        currentCode: _currentCode,
        currentCodeByFile: _currentCodeByFile,
        contextCodeByFile: _contextCodeByFile,
        ...rest
      } = t;
      return rest;
    }),
  };
}

/** The next brief the task loop runs: a settled brief after `from` is passed over, never current. */
function nextOpenTaskIndex(state: WorkflowState, from: number): number {
  const index = state.tasks.findIndex((t, i) => i >= from && !isTaskSettled(t.status));
  return index >= 0 ? index : state.tasks.length;
}

function advanceTask(state: WorkflowState, status: TaskStatus): WorkflowState {
  const currentId = state.tasks[state.currentTaskIndex]?.id;
  const withStatus = currentId ? setTaskStatus(state, currentId, status) : state;
  const stripped = currentId ? stripCurrentCode(withStatus, currentId) : withStatus;
  return {
    ...stripped,
    phase: 'implementing',
    currentTaskIndex: nextOpenTaskIndex(stripped, state.currentTaskIndex + 1),
    attempt: 0,
  };
}

function markRecoveryApplying(
  state: WorkflowState,
  action: Extract<StateAction, { type: 'MARK_RECOVERY_APPLYING' }>,
): WorkflowState {
  if (!state.pendingRecovery) return state;
  return {
    ...state,
    pendingRecovery: {
      ...state.pendingRecovery,
      status: 'applying',
      selectedAction: action.action,
    },
  };
}

/**
 * A recovery action that names a BUILD profile pins the brief to it until the
 * brief settles; one that names none leaves an earlier pin in place, so a
 * reopen that restarts the interrupted brief keeps the profile.
 */
function retryProfilePin(
  action: Extract<StateAction, { type: 'RESET_TASK' | 'RESTART_ATTEMPT_ON_SEAT' }>,
): Pick<WorkflowState, 'retryProfile'> {
  return action.profile === undefined
    ? {}
    : { retryProfile: { taskId: action.taskId, profile: action.profile } };
}

export function transition(
  state: WorkflowState,
  action: MachineAction,
  opts: { now?: Date | undefined } = {},
): WorkflowState {
  const now = opts.now ?? new Date();
  // A closed run is the one terminal state: nothing reopens it, so every action
  // but the close itself is refused rather than silently mutating a finished run.
  if (state.closed !== undefined && action.type !== 'CLOSE_RUN' && action.type !== 'APPLY_UNDONE') {
    throw transitionError.runClosed(action.type);
  }
  if (!canApplyAction(state.phase, action.type)) {
    throw transitionError.invalidActionForPhase(state.phase, action.type);
  }

  switch (action.type) {
    case 'START':
      return { ...state, phase: 'planning' };

    case 'BEGIN_PLANNING':
      return { ...state, phase: 'planning' };

    case 'PLAN_DONE':
      return { ...state, phase: 'reviewing-plan', tasks: action.tasks };

    case 'PLAN_COMPILED':
      return { ...state, plan: action.plan, tasks: action.tasks, rewindPending: undefined };

    // A correction at the plan card stands until a plan compiles, so a replan that stops keeps it.
    case 'CORRECT_PLAN':
      return { ...state, rewindPending: { target: 'plan', comment: action.comment } };

    case 'BEGIN_IMPLEMENTATION':
      return {
        ...state,
        phase: 'implementing',
        currentTaskIndex: 0,
        attempt: 0,
      };

    case 'START_TASK': {
      const index = state.tasks.findIndex((t) => t.id === action.taskId);
      return {
        ...setTaskStatus(state, action.taskId, 'in_progress'),
        ...(index >= 0 && { currentTaskIndex: index }),
      };
    }

    case 'TASK_SENT': {
      const sentId = state.tasks[state.currentTaskIndex]?.id;
      const cleaned = sentId ? stripCurrentCode(state, sentId) : state;
      return { ...cleaned, phase: 'validating-task' };
    }

    case 'RESUME_TASK':
      return { ...state, phase: 'implementing' };

    case 'VALIDATION_PASS': {
      const passed = advanceTask(state, taskStatusForCompletionMethod('local'));
      const passedId = state.tasks[state.currentTaskIndex]?.id;
      return passedId === undefined ? passed : dropClosedLineageStart(passed, passedId);
    }

    case 'VALIDATION_FAIL':
      if (state.attempt < DEFAULT_LOCAL_RETRIES) {
        return { ...state, phase: 'implementing', attempt: state.attempt + 1 };
      }
      return { ...state, phase: 'escalating' };

    case 'ESCALATE':
      return { ...state, phase: 'escalating' };

    case 'SKIP_TASK': {
      const withStatus = setTaskStatus(state, action.taskId, 'skipped');
      const skipped: WorkflowState = {
        ...withStatus,
        phase: 'implementing',
        currentTaskIndex: nextOpenTaskIndex(withStatus, state.currentTaskIndex + 1),
        attempt: 0,
      };
      const closed = dropClosedLineageStart(skipped, action.taskId);
      if (withStatus.changedFilesBaseline === undefined) return closed;
      // The skipped brief's task-start snapshot is no later brief's start.
      const { activeTaskSnapshot: _skippedTaskStart, ...baseline } =
        withStatus.changedFilesBaseline;
      return { ...closed, changedFilesBaseline: baseline };
    }

    case 'UPDATE_TASK_CODE': {
      const stripped = stripCurrentCode(state, action.taskId);
      return {
        ...stripped,
        tasks: stripped.tasks.map((t) =>
          t.id === action.taskId
            ? {
                ...t,
                action: action.action,
                ...(action.code !== undefined && { currentCode: action.code }),
                ...(action.codeByFile !== undefined && { currentCodeByFile: action.codeByFile }),
                ...(action.contextCodeByFile !== undefined && {
                  contextCodeByFile: action.contextCodeByFile,
                }),
              }
            : t,
        ),
      };
    }

    case 'ALL_DONE':
      return { ...state, phase: 'final-review' };

    case 'REVIEW_DONE':
      return {
        ...state,
        phase: 'complete',
        completedAt: now.toISOString(),
        reviewStatus: action.reviewStatus,
        acceptedAsIs: undefined,
        ...(action.candidate !== undefined && { reviewedCandidate: action.candidate }),
        ...(action.reviewStatus === 'passed' && {
          applyReview: undefined,
          pendingTriage: undefined,
        }),
      };

    case 'RECORD_REVIEW': {
      const record =
        action.review.scope === 'task' && state.pendingScheduledReview !== undefined
          ? { ...action.review, afterTaskId: state.pendingScheduledReview.afterTaskId }
          : action.review;
      const { open, ...fixCycles } = fixCyclesOf(state);
      if (open === undefined || !judgesCycle(state.triage, open, record)) {
        return { ...state, review: record, reviewAnswer: undefined };
      }
      return {
        ...state,
        review: { ...record, judges: open.cycle },
        reviewAnswer: undefined,
        fixCycles,
      };
    }

    case 'SAVE_REVIEW_ANSWER':
      return { ...state, reviewAnswer: action.answer };

    case 'DROP_REVIEW_ANSWER':
      return { ...state, reviewAnswer: undefined };

    case 'RECORD_REVIEW_CHECKS':
      return { ...state, reviewChecks: action.record };

    case 'SET_PENDING_REVIEW_COMMANDS':
      return {
        ...state,
        pendingReviewCommands: action.commands.length === 0 ? undefined : action.commands,
      };

    case 'RECORD_TRIAGE':
      return { ...state, triage: [...(state.triage ?? []), action.record] };

    case 'START_FIX_CYCLE': {
      if (state.phase === 'complete' && state.reviewStatus !== 'failed') {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      const fixCycles = fixCyclesOf(state);
      return {
        ...state,
        phase: 'implementing',
        currentTaskIndex: nextOpenTaskIndex(state, 0),
        fixCycles: {
          ...fixCycles,
          used: fixCycles.used + 1,
          open: {
            cycle: fixCycles.used + 1,
            ...(action.lastFixTaskId !== undefined && { lastFixTaskId: action.lastFixTaskId }),
          },
        },
        reviewStatus: undefined,
        completedAt: undefined,
        pendingTriage: undefined,
        pendingScheduledReview: undefined,
      };
    }

    case 'REVIEW_CORRECTION': {
      const scheduled = state.phase === 'implementing' && state.review?.scope === 'task';
      const failedFinalReview =
        (state.phase === 'complete' && state.reviewStatus === 'failed') ||
        (state.phase === 'final-review' && state.pendingRecovery?.reason === 'review-failed');
      if (!scheduled && !failedFinalReview) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      const fixCycles = fixCyclesOf(state);
      const inputs: TriageInput[] =
        action.text.trim() === ''
          ? []
          : [
              {
                id: `U${(state.triage?.length ?? 0) + 1}`,
                kind: 'defect',
                source: 'user',
                text: action.text,
                file: null,
              },
            ];
      return {
        ...state,
        phase: scheduled ? 'implementing' : 'final-review',
        reviewStatus: undefined,
        completedAt: undefined,
        pendingTriage: {
          inputs: [...(state.pendingTriage?.inputs ?? []), ...inputs],
          ...(state.pendingTriage?.question !== undefined && {
            question: state.pendingTriage.question,
          }),
          ...(state.pendingTriage?.reviewAfterTaskId !== undefined && {
            reviewAfterTaskId: state.pendingTriage.reviewAfterTaskId,
          }),
        },
        ...(inputs.length > 0 && {
          fixCycles: { ...fixCycles, notes: [...fixCycles.notes, action.text] },
        }),
      };
    }

    case 'QUEUE_TRIAGE': {
      const reviewAfterTaskId =
        action.reviewAfterTaskId ??
        state.pendingTriage?.reviewAfterTaskId ??
        state.pendingScheduledReview?.afterTaskId;
      return {
        ...state,
        pendingTriage: {
          inputs: action.inputs,
          ...(action.question !== undefined && { question: action.question }),
          ...(reviewAfterTaskId !== undefined && { reviewAfterTaskId }),
        },
        userAnswers: [
          ...(state.userAnswers ?? []),
          ...action.inputs
            .filter(
              (input) =>
                input.kind === 'answer' &&
                !state.pendingTriage?.inputs.some((previous) => previous.id === input.id),
            )
            .map((input) => ({
              reply: state.pendingTriage?.question?.question ?? input.id,
              answer: input.text,
            })),
        ],
      };
    }

    case 'RECORD_WORKSPACE':
      return { ...state, workspace: action.workspace };

    case 'ACCEPT_AS_IS':
      return {
        ...state,
        acceptedAsIs: {
          at: now.toISOString(),
          findings: action.findings,
          ...(action.note !== undefined && { note: action.note }),
        },
        applyReview: undefined,
        pendingTriage: undefined,
      };

    case 'APPLY_REVIEW_START': {
      if (deriveRunStatus({ state, liveness: 'not-alive' }).kind !== 'ready-to-apply') {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      const fixCycles = fixCyclesOf(state);
      return {
        ...state,
        phase: 'final-review',
        reviewStatus: undefined,
        completedAt: undefined,
        acceptedAsIs: undefined,
        applyReview: { merged: action.merged, failures: [] },
        ...(action.triage !== undefined
          ? { pendingTriage: { inputs: action.triage } }
          : { fixCycles: { ...fixCycles, used: fixCycles.used + 1 } }),
      };
    }

    case 'RECORD_APPLY_INTEGRATED': {
      const paths = new Set(action.integrated.map((record) => record.path));
      return {
        ...state,
        applyIntegrated: [
          ...(state.applyIntegrated ?? []).filter((record) => !paths.has(record.path)),
          ...action.integrated,
        ],
      };
    }

    // A resolution at the run base or on the checkout's side ends its record: Apply merges that
    // file again from then on.
    case 'BIND_APPLY_INTEGRATED':
      return {
        ...state,
        applyIntegrated: (state.applyIntegrated ?? []).flatMap((record) => {
          if (record.workspace !== null) return [record];
          const workspace = action.candidate[record.path];
          return workspace === undefined || workspace === record.checkout
            ? []
            : [{ ...record, workspace }];
        }),
      };

    case 'RECORD_APPLY_RECHECK':
      if (state.applyReview === undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return {
        ...state,
        applyReview: { ...state.applyReview, failures: action.failures, notRun: action.notRun },
      };

    case 'APPLY_START':
      if (!awaitsApply(state)) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return { ...state, applying: { at: now.toISOString(), backupId: action.backupId } };

    case 'APPLY_DONE': {
      if (state.applying === undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      const at = now.toISOString();
      return {
        ...state,
        applying: undefined,
        applied: { at, backupId: state.applying.backupId, files: action.files },
        closed: { at, as: 'applied' },
      };
    }

    case 'APPLY_RESTORED':
      if (state.applying === undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return { ...state, applying: undefined };

    case 'APPLY_UNDONE':
      if (state.applied === undefined || state.applied.undone !== undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return {
        ...state,
        applied: {
          ...state.applied,
          undone: { at: now.toISOString(), conflicts: action.conflicts },
        },
      };

    case 'CLOSE_RUN':
      if (deriveRunStatus({ state, liveness: 'not-alive' }).kind === 'closed') {
        return state;
      }
      return {
        ...state,
        closed: {
          at: action.at ?? now.toISOString(),
          as: action.as ?? 'ended',
          ...(action.patch !== undefined && { patch: action.patch }),
        },
        interruptedStep: undefined,
        pendingRecovery: undefined,
        pendingPlannerConversation: undefined,
      };

    case 'INTERRUPT_STEP':
      return {
        ...state,
        interruptedStep: {
          step: action.step,
          source: action.source,
          cut: action.cut,
          ...(action.partialRef ? { partialRef: action.partialRef } : {}),
          ...(action.kept !== undefined && action.kept.length > 0 && { kept: [...action.kept] }),
          at: now.toISOString(),
        },
        awaitingContinue: true,
      };

    case 'RECORD_REJECT': {
      // A brief that passed and had files put back is open again, so Continue builds it again. It
      // starts over: no earlier dispatch of it runs it on its own files.
      const reopened = state.tasks
        .filter((task) => action.booked.includes(task.id) && isTaskCompleted(task.status))
        .map((task) => task.id);
      const step = state.interruptedStep;
      if (reopened.length === 0 && step?.kept === undefined) return state;
      const reopenedState: WorkflowState = {
        ...state,
        tasks: state.tasks.map((task) =>
          reopened.includes(task.id) ? { ...task, status: 'pending' } : task,
        ),
        ...(state.lineages !== undefined && {
          lineages: Object.fromEntries(
            Object.entries(state.lineages).map(([key, lineage]) => [
              key,
              {
                ...lineage,
                dispatchedRevision: Object.fromEntries(
                  Object.entries(lineage.dispatchedRevision).filter(
                    ([id]) => !includes(reopened, id),
                  ),
                ),
              },
            ]),
          ),
        }),
      };
      const first = state.tasks.findIndex((task) => reopened.includes(task.id));
      const firstId = reopened[0];
      // The run moves back before the step it stopped or halted on, so a halt there is over, and the
      // next review judges a rebuilt candidate.
      if (firstId !== undefined && first < state.currentTaskIndex) {
        return {
          ...reopenedState,
          phase: 'implementing',
          currentTaskIndex: first,
          attempt: 0,
          pendingRecovery: undefined,
          pendingTriage: undefined,
          pendingScheduledReview: undefined,
          reviewAnswer: undefined,
          interruptedStep: {
            step: { kind: 'brief', taskId: firstId, attempt: 0 },
            source: step?.source ?? 'user',
            cut: 'boundary',
            at: step?.at ?? now.toISOString(),
          },
        };
      }
      if (step?.kept === undefined) return reopenedState;
      const removed = new Set(action.removed);
      const { kept: before, ...rest } = step;
      const kept = before.filter((file) => !removed.has(file));
      return { ...reopenedState, interruptedStep: kept.length > 0 ? { ...rest, kept } : rest };
    }

    case 'RESUME_STEP':
      return {
        ...state,
        ...(state.interruptedStep?.cut === 'mid-step' &&
          state.interruptedStep.step.kind === 'brief' &&
          state.rewindPending === undefined &&
          (state.phase === 'implementing' ||
            state.phase === 'validating-task' ||
            state.phase === 'escalating') && { phase: 'implementing' as const }),
        interruptedStep: undefined,
        awaitingContinue: false,
        lastFailure: undefined,
      };

    case 'RESTORE_BRIEF_PARK': {
      const idx = state.tasks.findIndex((t) => t.id === action.step.taskId);
      if (idx < 0) return state;
      return {
        ...setTaskStatus(state, action.step.taskId, 'in_progress'),
        currentTaskIndex: idx,
        attempt: action.step.attempt,
        phase: 'implementing',
        interruptedStep: {
          step: action.step,
          source: action.source,
          cut: 'mid-step',
          at: action.at,
        },
        awaitingContinue: true,
      };
    }

    case 'SET_PLANNER_CONVERSATION':
      return {
        ...state,
        phase:
          state.phase === 'implementing' ||
          state.phase === 'validating-task' ||
          state.phase === 'escalating'
            ? state.phase
            : action.conversation.call === 'research'
              ? 'researching'
              : action.conversation.call === 'spec'
                ? 'specifying'
                : 'planning',
        pendingPlannerConversation: action.conversation,
      };

    case 'CLEAR_PLANNER_CONVERSATION':
      return {
        ...state,
        userAnswers: [
          ...(state.userAnswers ?? []),
          ...(state.pendingPlannerConversation?.answers ?? []),
        ],
        pendingPlannerConversation: undefined,
        interruptedStep: undefined,
        awaitingContinue: false,
      };

    case 'SET_PLANNER_SESSION_ID':
      return { ...state, plannerSessionId: action.sessionId };

    case 'RESET_TASK': {
      const idx = state.tasks.findIndex((t) => t.id === action.taskId);
      if (idx < 0) return state;
      return {
        ...state,
        tasks: state.tasks.map((t, i) => (i === idx ? { ...t, status: 'pending' } : t)),
        currentTaskIndex: idx,
        attempt: 0,
        phase: 'implementing',
        ...(state.pendingRecovery?.taskId === action.taskId ? { pendingRecovery: undefined } : {}),
        ...retryProfilePin(action),
      };
    }

    case 'REPLACE_TASK': {
      const index = state.tasks.findIndex((t) => t.id === action.taskId);
      const previous = index < 0 ? undefined : state.tasks[index];
      if (previous === undefined) return state;
      const replacement: Task = {
        ...action.task,
        id: previous.id,
        ...(previous.fix !== undefined && {
          fix: previous.fix,
          description: fixBriefDescription(action.task.description, previous.fix.findings),
        }),
        ...(previous.parentId !== undefined && { parentId: previous.parentId }),
        criteria: previous.criteria,
        status: 'pending',
        revision: (previous.revision ?? 1) + 1,
      };
      return {
        ...state,
        tasks: state.tasks.map((task, i) => (i === index ? replacement : task)),
        attempt: 0,
      };
    }

    case 'INSERT_TASKS': {
      if (action.parentId === null) {
        if (action.afterTaskId === undefined) {
          return { ...state, tasks: [...state.tasks, ...action.tasks] };
        }
        const anchorIndex = state.tasks.findIndex((task) => task.id === action.afterTaskId);
        const insertAt = anchorIndex < 0 ? state.tasks.length : anchorIndex + 1;
        return {
          ...state,
          tasks: insertTasksAfter(state.tasks, action.tasks, action.afterTaskId),
          currentTaskIndex: Math.min(state.currentTaskIndex, insertAt),
        };
      }
      const parentIndex = state.tasks.findIndex((t) => t.id === action.parentId);
      const parent = parentIndex < 0 ? undefined : state.tasks[parentIndex];
      if (parent === undefined) return state;
      const lineageKey = lineageIdOf(parent);
      const children = action.tasks.map((task) => ({
        ...task,
        parentId: lineageKey,
        ...(parent.fix !== undefined && {
          fix: parent.fix,
          description: fixBriefDescription(task.description, parent.fix.findings),
        }),
      }));
      const childIds = children.map((task) => task.id);
      const remaining = state.tasks
        .filter((task) => task.id !== parent.id)
        .map((task) => {
          if (isTaskCompleted(task.status) || !task.dependsOn.includes(parent.id)) return task;
          return {
            ...task,
            dependsOn: [
              ...new Set(task.dependsOn.flatMap((dep) => (dep === parent.id ? childIds : [dep]))),
            ],
          };
        });
      const tasks = [
        ...remaining.slice(0, parentIndex),
        ...children,
        ...remaining.slice(parentIndex),
      ];
      const shift = parentIndex < state.currentTaskIndex ? children.length - 1 : 0;
      // A split last fix task hands its open fix cycle to its last child, the brief reviewed last.
      const open = state.fixCycles?.open;
      const lastChildId = childIds.at(-1);
      return {
        ...withLineage(state, lineageKey, (lineage) => ({
          ...lineage,
          replacedParents: [...lineage.replacedParents, parent],
        })),
        tasks,
        currentTaskIndex: state.currentTaskIndex + shift,
        ...(state.fixCycles !== undefined &&
          open?.lastFixTaskId === parent.id &&
          lastChildId !== undefined && {
            fixCycles: { ...state.fixCycles, open: { ...open, lastFixTaskId: lastChildId } },
          }),
      };
    }

    case 'RECORD_CONSULT': {
      const record: ConsultRecord = {
        reason: action.reason,
        action: action.answer.answer.action,
        diagnosis: action.answer.answer.diagnosis,
        at: now.toISOString(),
        taskId: action.taskId,
        revision: action.revision,
        answer: action.answer,
        seat: action.seat,
      };
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
        ...lineage,
        consults: lineage.consults + 1,
        consultRecords: [...lineage.consultRecords, record],
      }));
    }

    case 'RECORD_DECISIONS': {
      if (state.plan === undefined) return state;
      const recorded = state.plan.decisions;
      const added = [...new Set(action.decisions.map(decisionLedgerText))]
        .filter(
          (text) =>
            !recorded.some((entry) => entry.taskId === action.taskId && entry.text === text),
        )
        .map((text) => ({ text, taskId: action.taskId }));
      if (added.length === 0) return state;
      return { ...state, plan: { ...state.plan, decisions: [...recorded, ...added] } };
    }

    case 'RECORD_CORRECTION':
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
        ...lineage,
        corrections: [...(lineage.corrections ?? []), action.text],
      }));

    case 'COUNT_ATTEMPT':
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
        ...lineage,
        attempts: lineage.attempts + 1,
        ...(action.failure !== undefined && {
          attemptFailures: [
            ...(lineage.attemptFailures ?? []),
            {
              attempt: lineage.attempts + 1,
              taskId: action.taskId,
              revision: state.tasks.find((task) => task.id === action.taskId)?.revision ?? 1,
              line: truncateByChars(
                action.failure
                  .split('\n')
                  .map((line) => line.trim())
                  .find((line) => line !== '') ?? '',
                BOUNDS.consultAttemptLineChars,
              ),
            },
          ],
        }),
      }));

    case 'COUNT_PLANNER_CALL': {
      // Both consult seats spend this one allowance; the field keeps its planner name.
      const plannerCalls = plannerCallsOf(state);
      return { ...state, plannerCalls: { ...plannerCalls, used: plannerCalls.used + 1 } };
    }

    case 'CLEAR_CARRIED_FAILURE':
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => {
        const { carriedFailure: _carriedFailure, ...cleared } = lineage;
        return cleared;
      });

    case 'GRANT_ALLOWANCE': {
      const granted =
        action.taskId === null
          ? state
          : withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
              ...lineage,
              ...(action.target === 'lineage' && {
                consultAllowance: lineage.consultAllowance + BOUNDS.extraConsultsPerLineage,
                attemptAllowance: lineage.attemptAllowance + BOUNDS.extraAttemptsPerLineage,
              }),
              notes: [...lineage.notes, action.note],
              ...(action.failingOutput !== undefined && { carriedFailure: action.failingOutput }),
            }));
      if (action.target !== 'planner') return granted;
      const plannerCalls = plannerCallsOf(granted);
      return {
        ...granted,
        plannerCalls: {
          ...plannerCalls,
          allowance: plannerCalls.allowance + BOUNDS.extraPlannerCallsPerRun,
        },
      };
    }

    case 'START_SCHEDULED_REVIEW':
      return { ...state, pendingScheduledReview: { afterTaskId: action.afterTaskId } };

    case 'CLEAR_SCHEDULED_REVIEW':
      return { ...state, pendingScheduledReview: undefined, pendingTriage: undefined };

    case 'SET_TASK_INPUT_HASHES':
      return {
        ...withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
          ...lineage,
          staleConsultedRevision: {
            ...lineage.staleConsultedRevision,
            [action.taskId]: state.tasks.find((task) => task.id === action.taskId)?.revision ?? 1,
          },
        })),
        tasks: state.tasks.map((task) =>
          task.id === action.taskId ? { ...task, inputHashes: action.inputHashes } : task,
        ),
      };

    case 'RECORD_DISPATCH':
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
        ...lineage,
        dispatchedRevision: {
          ...lineage.dispatchedRevision,
          [action.taskId]: state.tasks.find((task) => task.id === action.taskId)?.revision ?? 1,
        },
        ...(lineage.startSnapshot === undefined &&
          state.changedFilesBaseline?.activeTaskSnapshot !== undefined && {
            startSnapshot: state.changedFilesBaseline.activeTaskSnapshot,
          }),
      }));

    case 'RECORD_CHECK_RESULTS':
      return {
        ...state,
        tasks: state.tasks.map((task) => {
          if (task.id !== action.taskId) return task;
          const results = new Map((task.checkResults ?? []).map((result) => [result.id, result]));
          for (const result of action.results) results.set(result.id, result);
          return { ...task, checkResults: [...results.values()] };
        }),
      };

    case 'SET_SEAT_WAIT':
      return { ...state, seatWait: action.wait };

    case 'CLEAR_SEAT_WAIT':
      return { ...state, seatWait: undefined };

    case 'ENQUEUE_USER_MSG':
      return { ...state, messageQueue: [...state.messageQueue, action.message] };

    case 'MARK_INJECTING_NATIVE':
      return {
        ...state,
        ...(action.attempt === undefined ? {} : { attempt: action.attempt }),
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id ? { ...m, nativeDeliveryState: 'injecting' } : m,
        ),
      };

    case 'MARK_DELIVERED_NATIVE':
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id
            ? {
                ...m,
                deliveredViaNative: true,
                nativeDeliveryState: 'delivered',
                ...(action.via === 'mid-call' && { deliveredMidCall: true }),
              }
            : m,
        ),
      };

    case 'MARK_NATIVE_DELIVERY_FAILED':
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id && m.nativeDeliveryState === 'injecting'
            ? { ...m, nativeDeliveryState: 'pending' }
            : m,
        ),
      };

    case 'MARK_POSSIBLE_DUPLICATE':
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id ? { ...m, possibleDuplicate: true } : m,
        ),
      };

    case 'DRAIN_QUEUE': {
      const ts = now.toISOString();
      const ids = action.ids === undefined ? undefined : new Set(action.ids);
      const destination = action.destination ?? 'implementer';
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) => {
          if (ids !== undefined && !ids.has(m.id)) return m;
          if (destination === 'reviewer') {
            if (m.deliveredTo?.reviewer !== undefined) return m;
            return {
              ...m,
              deliveredTo: { ...m.deliveredTo, reviewer: ts },
              ...(action.via === 'mid-call' && { deliveredMidCall: true }),
            };
          }
          if (!isQueuedMessagePendingDelivery(m)) return m;
          return {
            ...m,
            drainedAt: ts,
            deliveredTo: { ...m.deliveredTo, implementer: ts },
            ...(action.via === 'mid-call' && { deliveredMidCall: true }),
          };
        }),
      };
    }

    case 'CLEAR_QUEUE':
      return {
        ...state,
        messageQueue: state.messageQueue.filter((message) => !isQueuedMessageClearable(message)),
      };

    case 'SET_PENDING_RECOVERY':
      return { ...state, pendingRecovery: action.issue };

    case 'MARK_RECOVERY_APPLYING':
      return markRecoveryApplying(state, action);

    case 'RESOLVE_PENDING_RECOVERY':
      return { ...state, pendingRecovery: undefined };

    case 'RESTART_ATTEMPT_ON_SEAT': {
      const idx = state.tasks.findIndex((t) => t.id === action.taskId);
      if (idx < 0) return state;
      return {
        ...state,
        currentTaskIndex: idx,
        pendingRecovery: undefined,
        ...retryProfilePin(action),
      };
    }

    case 'RECORD_SEAT_SWITCH':
      return {
        ...state,
        seatSwitches: [
          ...(state.seatSwitches ?? []),
          {
            ...(action.switchId !== undefined && { switchId: action.switchId }),
            seat: action.seat,
            from: action.from,
            to: action.to,
            ...(action.fromSeat !== undefined && { fromSeat: action.fromSeat }),
            ...(action.toSeat !== undefined && { toSeat: action.toSeat }),
            cause: action.cause,
            ...(action.accountCause !== undefined && { accountCause: action.accountCause }),
            ...(action.headline !== undefined && { headline: action.headline }),
            auto: action.auto,
            configRevision: action.configRevision,
            ts: now.toISOString(),
          },
        ],
      };

    default:
      return assertNever(action);
  }
}
