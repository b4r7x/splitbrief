import type { TriageInput, TriageResult } from '../../../../core/schemas/review/verdict.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { consultReplyAnswer } from '../../consult/ask-user.js';
import { askOperator } from '../../planning/call-loop.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../../state-ops/head.js';
import { recordUserMessage } from '../../transcript/user-message.js';
import type { WorkflowContext, OrchestratorCallbacks } from '../../types.js';
import { haltFailedReview } from './halts.js';

/**
 * The question a review answer asks you: it waits in the triage queue, and your answer joins the
 * triage inputs as `A<n>` for the review to judge again. No answer halts the failed review.
 */
export async function followReviewQuestion(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  callbacks: OrchestratorCallbacks;
  candidate: Record<string, string> | undefined;
  ask: NonNullable<TriageResult['ask']>;
  inputs: readonly TriageInput[];
  blocking: number;
  redInputs: readonly TriageInput[];
}): Promise<Readonly<{ state: WorkflowState; next: 'stop' | 'review' }>> {
  const { wctx, setTrackedState, inputs } = args;
  let state = transitionAndSave(wctx, args.state, {
    type: 'QUEUE_TRIAGE',
    inputs: [...inputs],
    question: args.ask,
  });
  setTrackedState(state);
  const question = args.ask.question;
  const asking = await askOperator({ ...wctx, callbacks: args.callbacks }, state, {
    call: 'plan',
    text: question,
    questions: [{ id: 'review-ask', type: 'input', text: question }],
    answers: [],
    answered: false,
  });
  state = asking.state;
  const reply = asking.reply;
  if (reply === undefined) {
    state = await haltFailedReview({
      wctx,
      state,
      setTrackedState,
      candidate: args.candidate,
      blocking: args.blocking,
      redInputs: args.redInputs,
      question,
    });
    return { state, next: 'stop' };
  }
  const answered = consultReplyAnswer({ id: 'review-ask', type: 'input', text: question }, reply);
  state = transitionAndSave(wctx, state, {
    type: 'QUEUE_TRIAGE',
    inputs: [
      ...inputs,
      {
        id: `A${inputs.length + 1}`,
        kind: 'answer',
        source: 'user',
        text: answered.message.text,
        file: null,
      },
    ],
  });
  recordUserMessage({ ...wctx, phase: state.phase }, answered.message, {
    qa: answered.qa,
    answerIndex: (state.userAnswers?.length ?? 0) - 1,
  });
  state = rebaseOnPersistedWorkflowState(wctx, state);
  setTrackedState(state);
  return { state, next: 'review' };
}
