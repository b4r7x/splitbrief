import { fixBriefDescription } from '../review/fix-task.js';
import { awaitsApply, deriveRunStatus } from '../sessions/run-status.js';
import type { MachineAction, StateAction } from './types.js';
import {
  WORKFLOW_STATE_VERSION,
  fixCyclesOf,
  plannerCallsOf,
  type ConsultRecord,
  type LineageRecord,
  type WorkflowState,
} from '../schemas/workflow.js';
import { isTaskCompleted, type Task, type TaskId } from '../schemas/task.js';
import type { TriageInput } from '../schemas/review.js';
import type { Phase, TaskStatus } from '../schemas/enums.js';
import { ZERO_TOKEN_USAGE } from '../schemas/tokens.js';
import { isQueuedMessageClearable, isQueuedMessagePendingDelivery } from '../queue-state.js';
import { taskStatusForCompletionMethod } from '../task-completion.js';
import { assertNever } from '../../utils/type-guards.js';
import { includes } from '../../utils/type-guards.js';
import { DEFAULT_LOCAL_RETRIES } from '../pipeline-spec/retries.js';
import { BOUNDS } from '../pipeline-spec/bounds.js';
import { insertTasksAfter, lineageIdOf } from './task-insert.js';
import { transitionError } from './errors.js';

/** The text a confirmed implementer decision contributes to the plan ledger. */
export function decisionLedgerText(decision: { what: string; why: string }): string {
  return `${decision.what} — ${decision.why}`;
}

const anytimeActions = [
  'CLOSE_RUN',
  'RECORD_WORKSPACE',
  'INTERRUPT_STEP',
  'RESUME_STEP',
  'RESTORE_BRIEF_PARK',
  'SET_PLANNER_CONVERSATION',
  'CLEAR_PLANNER_CONVERSATION',
  'SET_PLANNER_SESSION_ID',
  'ENQUEUE_USER_MSG',
  'MARK_INJECTING_NATIVE',
  'MARK_DELIVERED_NATIVE',
  'MARK_NATIVE_DELIVERY_FAILED',
  'DRAIN_QUEUE',
  'CLEAR_QUEUE',
  'SET_PENDING_RECOVERY',
  'MARK_RECOVERY_APPLYING',
  'RESOLVE_PENDING_RECOVERY',
  'REPLACE_TASK',
  'INSERT_TASKS',
  'RECORD_CONSULT',
  'CONFIRM_DECISIONS',
  'RECORD_CORRECTION',
  'COUNT_ATTEMPT',
  'COUNT_PLANNER_CALL',
  'CLEAR_CARRIED_FAILURE',
  'GRANT_ALLOWANCE',
  'SET_TASK_INPUT_HASHES',
  'RECORD_CHECK_RESULTS',
  'SET_SEAT_WAIT',
  'CLEAR_SEAT_WAIT',
  'START_SCHEDULED_REVIEW',
  'CLEAR_SCHEDULED_REVIEW',
  'SET_PENDING_BOUNDARY',
  'CLEAR_PENDING_BOUNDARY',
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
    'RECORD_TRIAGE',
    'START_FIX_CYCLE',
    'REVIEW_CORRECTION',
    'QUEUE_TRIAGE',
    'ACCEPT_AS_IS',
  ],
  'validating-task': [...VALIDATION_OR_ESCALATION_SHARED_ACTIONS, 'VALIDATION_FAIL', 'ESCALATE'],
  escalating: [...VALIDATION_OR_ESCALATION_SHARED_ACTIONS, 'UPDATE_TASK_CODE'],
  'final-review': [
    'REVIEW_DONE',
    'RECORD_APPLY_RECHECK',
    'RECORD_REVIEW',
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
    'APPLY_START',
    'APPLY_DONE',
    'APPLY_RESTORED',
    'APPLY_UNDONE',
  ],
} as const satisfies Record<Phase, readonly MachineAction['type'][]>;

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

function setTaskStatus(state: WorkflowState, taskId: TaskId, status: TaskStatus): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
  };
}

const EMPTY_LINEAGE: LineageRecord = {
  consults: 0,
  attempts: 0,
  consultAllowance: BOUNDS.consultsPerLineage,
  attemptAllowance: BOUNDS.attemptsPerLineage,
  staleConsultedRevision: {},
  consultRecords: [],
  replacedParents: [],
  notes: [],
};

function lineageKeyFor(state: WorkflowState, taskId: TaskId): TaskId {
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

/** The next brief the task loop runs: a passed brief after `from` is skipped, never current. */
function nextOpenTaskIndex(state: WorkflowState, from: number): number {
  const index = state.tasks.findIndex((t, i) => i >= from && !isTaskCompleted(t.status));
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

    case 'VALIDATION_PASS':
      return advanceTask(state, taskStatusForCompletionMethod('local'));

    case 'VALIDATION_FAIL':
      if (state.attempt < DEFAULT_LOCAL_RETRIES) {
        return { ...state, phase: 'implementing', attempt: state.attempt + 1 };
      }
      return { ...state, phase: 'escalating' };

    case 'ESCALATE':
      return { ...state, phase: 'escalating' };

    case 'SKIP_TASK': {
      const withStatus = setTaskStatus(state, action.taskId, 'skipped');
      return {
        ...withStatus,
        phase: 'implementing',
        currentTaskIndex: nextOpenTaskIndex(withStatus, state.currentTaskIndex + 1),
        attempt: 0,
      };
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
        ...(action.candidate !== undefined && { reviewedCandidate: action.candidate }),
        ...(action.reviewStatus === 'passed' && { applyReview: undefined }),
      };

    case 'RECORD_REVIEW': {
      const record = action.review;
      return {
        ...state,
        review:
          record.scope === 'task' && state.pendingScheduledReview !== undefined
            ? { ...record, afterTaskId: state.pendingScheduledReview.afterTaskId }
            : record,
      };
    }

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
        fixCycles: { ...fixCycles, used: fixCycles.used + 1 },
        reviewStatus: undefined,
        completedAt: undefined,
        pendingTriage: undefined,
        pendingScheduledReview: undefined,
      };
    }

    case 'REVIEW_CORRECTION': {
      const scheduled = state.phase === 'implementing' && state.review?.scope === 'task';
      if (!scheduled && (state.phase !== 'complete' || state.reviewStatus !== 'failed')) {
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
        ...(fixCycles.used >= fixCycles.allowance && {
          fixCycles: {
            ...fixCycles,
            allowance: fixCycles.allowance + BOUNDS.extraFixCyclesPerRun,
            notes: [...fixCycles.notes, action.text],
          },
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
        acceptedAsIs: { at: now.toISOString(), findings: action.findings },
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
        ...(action.integrated !== undefined && {
          applyIntegrated: [...(state.applyIntegrated ?? []), ...action.integrated],
        }),
        ...(action.triage !== undefined
          ? { pendingTriage: { inputs: action.triage } }
          : { fixCycles: { ...fixCycles, used: fixCycles.used + 1 } }),
      };
    }

    case 'RECORD_APPLY_RECHECK':
      if (state.applyReview === undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return { ...state, applyReview: { ...state.applyReview, failures: action.failures } };

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
          at: now.toISOString(),
        },
        awaitingContinue: true,
      };

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
      return {
        ...withLineage(state, lineageKey, (lineage) => ({
          ...lineage,
          replacedParents: [...lineage.replacedParents, parent],
        })),
        tasks,
        currentTaskIndex: state.currentTaskIndex + shift,
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
      };
      return withLineage(state, lineageKeyFor(state, action.taskId), (lineage) => ({
        ...lineage,
        consults: lineage.consults + (action.reason === 'deviation' ? 0 : 1),
        consultRecords: [...lineage.consultRecords, record],
        ...(action.reason === 'stale' && {
          staleConsultedRevision: {
            ...lineage.staleConsultedRevision,
            [action.taskId]: action.revision,
          },
        }),
      }));
    }

    case 'CONFIRM_DECISIONS': {
      if (state.plan === undefined) return state;
      return {
        ...state,
        plan: {
          ...state.plan,
          decisions: [
            ...state.plan.decisions,
            ...action.decisions.map((decision) => ({
              text: decisionLedgerText(decision),
              taskId: action.taskId,
            })),
          ],
        },
      };
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
      }));

    case 'COUNT_PLANNER_CALL': {
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

    case 'SET_PENDING_BOUNDARY':
      return {
        ...state,
        pendingBoundary: { batch: action.batch, afterTaskId: action.afterTaskId },
      };

    case 'CLEAR_PENDING_BOUNDARY':
      return { ...state, pendingBoundary: undefined };

    case 'SET_TASK_INPUT_HASHES':
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === action.taskId ? { ...task, inputHashes: action.inputHashes } : task,
        ),
      };

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
      return { ...state, seatWait: { seat: action.seat, resetAt: action.resetAt } };

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
            ? { ...m, deliveredViaNative: true, nativeDeliveryState: 'delivered' }
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

    case 'DRAIN_QUEUE': {
      const ts = now.toISOString();
      const ids = action.ids === undefined ? undefined : new Set(action.ids);
      const destination = action.destination ?? 'implementer';
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) => {
          if (ids !== undefined && !ids.has(m.id)) return m;
          if (destination === 'consult') {
            if (m.deliveredTo?.consult !== undefined) return m;
            return { ...m, deliveredTo: { ...m.deliveredTo, consult: ts } };
          }
          if (destination === 'reviewer') {
            if (m.deliveredTo?.reviewer !== undefined) return m;
            return { ...m, deliveredTo: { ...m.deliveredTo, reviewer: ts } };
          }
          if (!isQueuedMessagePendingDelivery(m)) return m;
          return { ...m, drainedAt: ts, deliveredTo: { ...m.deliveredTo, implementer: ts } };
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

    default:
      return assertNever(action);
  }
}
