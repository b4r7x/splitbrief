import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import { sessionConversation } from '../../../core/state/planning-conversation.js';
import { resumeStep } from '../../../core/sessions/run/status.js';
import { publishPlannerStatus } from '../publish/runner.js';
import { publishInfo } from '../publish/notice.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { handlePlanningFailure } from './failure.js';
import { runPlanSession } from './plan-session.js';
import { formatMessageInput, imagesFromMessages } from '../queue/prompt.js';
import type { PlanningPhaseOptions, PlanningProducerResult, PlanningTurnState } from './types.js';
import { settle } from './answers.js';
import { earlierPlanning, planTurnText } from './turn-text.js';
import { checkFullPlan } from './compile.js';
import { answerRound, askTurn } from './turn-state.js';

/**
 * One planning session on the run: the planner answers in typed JSON, questions wait in the
 * composer, and a plan that passes its checks lands as `plan.json` with `plan.md` and `tasks.md`
 * rendered from it. `lead` is what the user asked of this session: a planner on its own session
 * hears it once, and every full turn of any other planner carries it again.
 */
export async function runPlanningSession(
  opts: PlanningPhaseOptions,
  lead?: string | undefined,
): Promise<PlanningProducerResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus } = wctx;
  const ref = { projectDir, sessionId };
  const steer = wctx.continuation?.take(
    resumeStep(opts.state, resolveReviewCadence(wctx.config) === 'none'),
  )?.steer;
  // A run continued with a steer while its planner question waited: the steer is the answer.
  const conversation = opts.state.pendingPlannerConversation;
  const steerAnswer =
    conversation !== undefined && !conversation.answered && steer?.text.trim() ? steer : undefined;
  const pending = sessionConversation(opts.state);
  const earlier = earlierPlanning(
    ref,
    opts.state,
    pending === undefined ? steerAnswer?.text : undefined,
  );
  const standing = [
    lead,
    steerAnswer === undefined && steer !== undefined ? formatMessageInput(steer) : undefined,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n\n');
  // A session continued after a stop at its questions: a planner on its own session still holds
  // what the user asked of it, any other planner reads it again on every full turn.
  const fullStanding = [lead === undefined ? pending?.lead : undefined, standing]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n\n');
  const shared: PlanningTurnState = {
    state: opts.state,
    resumedAnswer: pending === undefined ? undefined : steerAnswer,
    standingHeard: false,
    images: imagesFromMessages([
      { images: opts.attachments ?? [] },
      ...(steer === undefined ? [] : [steer]),
    ]),
    priorMessages: wctx.resumeHolder?.messages,
  };

  if (shared.state.pendingPlannerConversation !== undefined && pending === undefined) {
    shared.state = transitionAndSave(ref, shared.state, { type: 'CLEAR_PLANNER_CONVERSATION' });
  }

  try {
    if (opts.beforeFirstCall && !(await opts.beforeFirstCall())) {
      return { disposition: 'terminal', state: shared.state, outcome: 'cancelled' };
    }
    if (shared.state.phase !== 'planning') {
      shared.state = transitionAndSave(
        ref,
        shared.state,
        shared.state.phase === 'idle' ? { type: 'START' } : { type: 'BEGIN_PLANNING' },
      );
    }
    publishPlannerStatus(bus, shared.state, 'running', { call: 'plan' });

    const turnText = await planTurnText({
      wctx,
      planner,
      feature: opts.feature,
      language: shared.state.discoveredValidation?.language,
      earlierPlanning: earlier,
      steer: standing,
      onWarn: (message, details) =>
        bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: shared.state.phase,
          message,
          ...(details === undefined ? {} : { details }),
        }),
    });
    const input = { wctx, planner, lead, standing, fullStanding, turnText };

    const outcome = await runPlanSession({
      rounds: sessionConversation(shared.state)?.answers.length ?? 0,
      ...(pending !== undefined && !pending.answered && { pending: pending.questions }),
      ask: (turn) => askTurn(input, shared, turn),
      answer: (questions, round) => answerRound(input, shared, questions, round),
      check: (plan) => checkFullPlan(wctx, plan),
    });
    if (outcome.kind === 'plan' && outcome.checksRepaired) {
      publishInfo({
        bus,
        phase: shared.state.phase,
        message: 'The revised plan passes its checks.',
      });
    }
    return await settle(opts, shared.state, outcome);
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state: shared.state, wctx });
  }
}
