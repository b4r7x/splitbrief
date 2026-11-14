import { isTaskSettled, type TaskId } from '../../schemas/task.js';
import type { TaskStatus } from '../../schemas/enums.js';
import type { WorkflowState } from '../../schemas/workflow/state.js';
import { BOUNDS } from '../../pipeline-spec/bounds.js';
import { taskStatusForCompletionMethod } from '../../task-completion.js';
import { truncateByChars } from '../../../utils/display-text/truncate.js';
import { assertNever } from '../../../utils/type-guards.js';
import { dropClosedLineageStart, lineageKeyFor, withLineage } from '../lineage.js';
import type { MachineAction } from '../types.js';

/** A brief's recovery pin ends when the brief settles: until then every route of it reads the pin. */
export function setTaskStatus(
  state: WorkflowState,
  taskId: TaskId,
  status: TaskStatus,
): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
    ...(state.retryProfile?.taskId === taskId &&
      isTaskSettled(status) && { retryProfile: undefined }),
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

/** The next brief the task loop runs: a settled brief after `from` is passed over, never current. */
export function nextOpenTaskIndex(state: WorkflowState, from: number): number {
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

type FamilyAction = Extract<
  MachineAction,
  {
    type:
      | 'START_TASK'
      | 'TASK_SENT'
      | 'RESUME_TASK'
      | 'VALIDATION_PASS'
      | 'VALIDATION_FAIL'
      | 'ESCALATE'
      | 'SKIP_TASK'
      | 'UPDATE_TASK_CODE'
      | 'ALL_DONE'
      | 'COUNT_ATTEMPT'
      | 'RECORD_DISPATCH'
      | 'RECORD_CHECK_RESULTS';
  }
>;

export function transitionTask(state: WorkflowState, action: FamilyAction): WorkflowState {
  switch (action.type) {
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

    default:
      return assertNever(action);
  }
}
