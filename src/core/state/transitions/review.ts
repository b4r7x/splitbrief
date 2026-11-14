import { fixCyclesOf, type WorkflowState } from '../../schemas/workflow/state.js';
import type { FixCycles, ReviewRecord } from '../../schemas/workflow/review-record.js';
import type { TriageInput } from '../../schemas/review/verdict.js';
import { assertNever } from '../../../utils/type-guards.js';
import { transitionError } from '../errors.js';
import type { MachineAction } from '../types.js';
import { nextOpenTaskIndex } from './task.js';

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

type FamilyAction = Extract<
  MachineAction,
  {
    type:
      | 'REVIEW_DONE'
      | 'RECORD_REVIEW'
      | 'RECORD_TRIAGE'
      | 'START_FIX_CYCLE'
      | 'REVIEW_CORRECTION'
      | 'QUEUE_TRIAGE'
      | 'START_SCHEDULED_REVIEW'
      | 'CLEAR_SCHEDULED_REVIEW';
  }
>;

export function transitionReview(
  state: WorkflowState,
  action: FamilyAction,
  now: Date,
): WorkflowState {
  switch (action.type) {
    case 'REVIEW_DONE':
      return {
        ...state,
        phase: 'complete',
        completedAt: now.toISOString(),
        reviewStatus: action.reviewStatus,
        acceptedAsIs: undefined,
        ...(action.candidate !== undefined && { reviewedCandidate: action.candidate }),
        ...(action.reviewStatus !== 'failed' && {
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
        return { ...state, review: record };
      }
      return { ...state, review: { ...record, judges: open.cycle }, fixCycles };
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
        fixCycles: {
          ...fixCycles,
          used: fixCycles.used + 1,
          ...(action.lastFixTaskId !== undefined && { briefed: fixCycles.briefed + 1 }),
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
          ...(action.plannerConsult === true && { plannerConsult: true }),
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

    case 'START_SCHEDULED_REVIEW':
      return { ...state, pendingScheduledReview: { afterTaskId: action.afterTaskId } };

    case 'CLEAR_SCHEDULED_REVIEW':
      return { ...state, pendingScheduledReview: undefined, pendingTriage: undefined };

    default:
      return assertNever(action);
  }
}
