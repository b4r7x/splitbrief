import type { PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { sessionConversation } from '../../../core/state/planning-conversation.js';
import { nowIso } from '../../../utils/format/time.js';
import { MAX_QUESTION_ROUNDS } from '../../spec/prompts/plan-session.js';
import { publishError } from '../publish/notice.js';
import { buildPlanSessionHaltRecoveryIssue } from '../recovery/builders/planner.js';
import { seatProtocolHaltIssue } from '../recovery/seat/protocol-halt.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { recordUserMessage } from '../transcript/user-message.js';
import type { PlannerCallbacksContext } from '../types.js';
import { raisePlanningHalt } from './halt.js';
import type { PlanSessionOutcome, PlanSessionUnanswered } from './plan-session.js';
import { compilePlan } from './compile.js';
import type { PlanningPhaseOptions, PlanningPhaseResult, PlanningProducerResult } from './types.js';

type Terminal = Extract<PlanningPhaseResult, { disposition: 'terminal' }>;

/** The answer joins the session's conversation before the call that carries it. */
export function recordAnswers(
  wctx: PlannerCallbacksContext,
  state: WorkflowState,
  reply: PlannerReplyAnswer,
): WorkflowState {
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const asked = sessionConversation(state);
  const next =
    asked === undefined
      ? state
      : transitionAndSave(ref, state, {
          type: 'SET_PLANNER_CONVERSATION',
          conversation: {
            ...asked,
            answers: [...asked.answers, { reply: asked.text, answer: reply.message.text }],
            answered: true,
          },
        });
  recordUserMessage({ ...ref, bus: wctx.bus, phase: next.phase }, reply.message, {
    qa: reply.qa,
    ...(asked !== undefined && {
      answerIndex: (next.userAnswers?.length ?? 0) + asked.answers.length,
    }),
    ...(asked !== undefined && reply.qa.length === 0 && { questions: asked.questions }),
  });
  return rebaseOnPersistedWorkflowState(ref, next);
}

export async function settle(
  opts: PlanningPhaseOptions,
  state: WorkflowState,
  outcome: PlanSessionOutcome | PlanSessionUnanswered,
): Promise<PlanningProducerResult> {
  const { wctx } = opts;
  const { projectDir, sessionId, bus, config } = wctx;
  const ref = { projectDir, sessionId };
  const halt = (issue: Parameters<typeof raisePlanningHalt>[2]): Terminal => ({
    disposition: 'terminal',
    state: raisePlanningHalt({ ...ref, bus }, state, issue),
    outcome: 'halted',
  });

  switch (outcome.kind) {
    case 'plan':
      return { disposition: 'tasks-ready', ...compilePlan(wctx, state, outcome.plan) };
    case 'unanswered':
      return { disposition: 'terminal', state, outcome: 'input-required' };
    case 'questions-exhausted':
      return halt(
        buildPlanSessionHaltRecoveryIssue({
          reason: 'plan-questions-exhausted',
          phase: state.phase,
          message: `The planner asked a third round of questions; a session takes ${MAX_QUESTION_ROUNDS}.`,
          details: outcome.questions.map((question) => question.text),
          createdAt: nowIso(),
        }),
      );
    case 'checks-failed':
      return halt(
        buildPlanSessionHaltRecoveryIssue({
          reason: 'plan-checks-failed',
          phase: state.phase,
          message: 'The plan failed its checks again after one repair.',
          details: outcome.errors.flatMap(({ message, detail }) =>
            detail === undefined ? [message] : [message, detail],
          ),
          createdAt: nowIso(),
        }),
      );
    default: {
      publishError({ bus, phase: state.phase, message: outcome.error.message });
      const issue = await seatProtocolHaltIssue({
        projectDir,
        config,
        modelCache: wctx.modelCache,
        signal: wctx.signal,
        error: outcome.error,
        phase: state.phase,
      });
      return halt(issue);
    }
  }
}
