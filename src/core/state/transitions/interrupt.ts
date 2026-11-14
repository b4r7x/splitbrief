import { isTaskCompleted } from '../../schemas/task.js';
import type { WorkflowState } from '../../schemas/workflow/state.js';
import { BOUNDS } from '../../pipeline-spec/bounds.js';
import { truncateByChars } from '../../../utils/display-text/truncate.js';
import { assertNever, includes } from '../../../utils/type-guards.js';
import type { MachineAction } from '../types.js';
import { setTaskStatus } from './task.js';

type FamilyAction = Extract<
  MachineAction,
  {
    type:
      | 'INTERRUPT_STEP'
      | 'RECORD_REJECT'
      | 'RESUME_STEP'
      | 'CONTINUE_STEP'
      | 'RESTORE_BRIEF_PARK';
  }
>;

export function transitionInterrupt(
  state: WorkflowState,
  action: FamilyAction,
  now: Date,
): WorkflowState {
  switch (action.type) {
    case 'INTERRUPT_STEP':
      return {
        ...state,
        interruptedStep: {
          step: action.step,
          source: action.source,
          cut: action.cut,
          ...(action.partialRef ? { partialRef: action.partialRef } : {}),
          ...(action.kept !== undefined && action.kept.length > 0 && { kept: [...action.kept] }),
          ...(action.consult !== undefined && {
            consult: {
              ...action.consult,
              failingOutput: truncateByChars(
                action.consult.failingOutput,
                BOUNDS.consultFailingOutputChars,
              ),
            },
          }),
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

    case 'CONTINUE_STEP':
      return {
        ...state,
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

    default:
      return assertNever(action);
  }
}
