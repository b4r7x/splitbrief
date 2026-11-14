import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import {
  PLAN_ANSWER_JSON_SCHEMA,
  PlanAnswerSchema,
  type PlanAnswer,
} from '../../../core/schemas/plan.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { questionsText, sessionConversation } from '../../../core/state/planning-conversation.js';
import { appendMessage } from '../../../core/sessions/log/writer.js';
import { resumeStep } from '../../../core/sessions/run/status.js';
import { createLogger } from '../../../lib/logger.js';
import type { PriorMessage } from '../../planners/types.js';
import type { RequestTypedResult } from '../../runners/typed-output.js';
import { planRepairWarning } from '../../spec/plan/checks.js';
import {
  MAX_QUESTION_ROUNDS,
  planAnswersTurn,
  questionRoundLimit,
  planFullTurn,
  planRepairTurn,
} from '../../spec/prompts/plan-session.js';
import { withContinuationLoop } from '../continuation/loop.js';
import {
  createBusTextHandler,
  publishPlannerStatus,
  publishRunnerCallEvent,
} from '../publish/runner.js';
import { publishInfo } from '../publish/notice.js';
import { askPlannerSession } from '../planner-session.js';
import { addUsageAndSave } from '../state-ops/usage.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { askOperator } from './call-loop.js';
import { handlePlanningFailure } from './failure.js';
import { startPlannerHeartbeat } from './heartbeat.js';
import { runPlanSession, type PlanTurn } from './plan-session.js';
import { drainAndFormat } from './queue-drain.js';
import { formatMessageInput, imagesFromMessages } from '../queue/prompt.js';
import type { PlanningPhaseOptions, PlanningProducerResult } from './types.js';
import { recordAnswers, settle } from './answers.js';
import { earlierPlanning, planTurnText } from './turn-text.js';
import { checkFullPlan } from './compile.js';

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
  let state = opts.state;
  const steer = wctx.continuation?.take(
    resumeStep(state, resolveReviewCadence(wctx.config) === 'none'),
  )?.steer;
  // A run continued with a steer while its planner question waited: the steer is the answer.
  const conversation = state.pendingPlannerConversation;
  const steerAnswer =
    conversation !== undefined && !conversation.answered && steer?.text.trim() ? steer : undefined;
  const pending = sessionConversation(state);
  const earlier = earlierPlanning(
    ref,
    state,
    pending === undefined ? steerAnswer?.text : undefined,
  );
  let resumedAnswer = pending === undefined ? undefined : steerAnswer;
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
  let standingHeard = false;
  let note = '';
  let images = imagesFromMessages([
    { images: opts.attachments ?? [] },
    ...(steer === undefined ? [] : [steer]),
  ]);
  let priorMessages = wctx.resumeHolder?.messages;

  if (state.pendingPlannerConversation !== undefined && pending === undefined) {
    state = transitionAndSave(ref, state, { type: 'CLEAR_PLANNER_CONVERSATION' });
  }

  try {
    if (opts.beforeFirstCall && !(await opts.beforeFirstCall())) {
      return { disposition: 'terminal', state, outcome: 'cancelled' };
    }
    if (state.phase !== 'planning') {
      state = transitionAndSave(
        ref,
        state,
        state.phase === 'idle' ? { type: 'START' } : { type: 'BEGIN_PLANNING' },
      );
    }
    publishPlannerStatus(bus, state, 'running', { call: 'plan' });

    const turnText = await planTurnText({
      wctx,
      planner,
      feature: opts.feature,
      language: state.discoveredValidation?.language,
      earlierPlanning: earlier,
      steer: standing,
      onWarn: (message, details) =>
        bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: state.phase,
          message,
          ...(details === undefined ? {} : { details }),
        }),
    });

    const rounds = (): number => sessionConversation(state)?.answers.length ?? 0;

    const compose = async (
      turn: PlanTurn,
      onSession: boolean,
      interruptSteer: string | undefined,
      prior: readonly PriorMessage[] | undefined,
    ): Promise<string> => {
      const sessionBody = !onSession
        ? undefined
        : turn.kind === 'answers'
          ? planAnswersTurn(
              turn.reply.message.text,
              rounds(),
              questionRoundLimit(state.decideForMe),
            )
          : turn.kind === 'repair'
            ? planRepairTurn(turn.errors)
            : lead !== undefined
              ? ''
              : undefined;
      const opening = sessionBody !== undefined && !standingHeard ? standing : '';
      const said = interruptSteer?.trim() ? interruptSteer : undefined;
      const around = (body: string) =>
        [note, opening, body, said ? `The user says: ${said}` : '']
          .filter((part) => part !== '')
          .join('\n\n');
      if (sessionBody !== undefined) return around(sessionBody);
      return turnText(
        (prompt) =>
          around(
            planFullTurn(
              prompt,
              sessionConversation(state)?.answers ?? [],
              turn.kind === 'repair' ? turn : undefined,
              fullStanding,
              questionRoundLimit(state.decideForMe),
            ),
          ),
        prior,
      );
    };

    const ask = async (turn: PlanTurn): Promise<RequestTypedResult<PlanAnswer>> => {
      if (turn.kind === 'answers') state = recordAnswers(wctx, state, turn.reply);
      if (turn.kind === 'repair') {
        createLogger('engine').debug('plan_send_back', planRepairWarning(turn.errors));
      }
      const drained = await drainAndFormat(projectDir, sessionId, state, bus);
      state = drained.state;
      note = [drained.prefix.trim(), note].filter((part) => part !== '').join('\n\n');
      images = imagesFromMessages([
        { images },
        ...drained.messages,
        ...(turn.kind === 'answers' ? [turn.reply.message] : []),
      ]);

      const loop = await withContinuationLoop<RequestTypedResult<PlanAnswer>>({
        ctx: {
          projectDir,
          sessionId,
          callbacks: wctx.callbacks,
          bus,
          signal: wctx.signal,
          sinks: wctx.sinks,
        },
        state,
        step: { kind: 'planner', call: 'plan' },
        onStateChange: (next) => {
          state = next;
        },
        body: async ({ signal, steer: interruptSteer, steerInput }) => {
          const callImages = imagesFromMessages([
            { images },
            ...(steerInput === undefined ? [] : [steerInput]),
          ]);
          const heartbeat = startPlannerHeartbeat(bus, state.phase, Date.now());
          try {
            const asked = await askPlannerSession(
              {
                projectDir,
                sessionId,
                bus,
                planner,
                config: wctx.config,
                ...(wctx.steering !== undefined && { steering: wctx.steering }),
                state,
                signal,
                onStateChange: (next) => {
                  state = next;
                },
              },
              {
                schema: PlanAnswerSchema,
                jsonSchema: PLAN_ANSWER_JSON_SCHEMA,
                schemaName: 'plan_result',
                ...(callImages.length > 0 && { images: callImages }),
                ...(priorMessages !== undefined && { priorMessages }),
                compose: ({ onSession, priorMessages: prior }) =>
                  compose(turn, onSession, interruptSteer, prior),
                onCallEvent: (event) => {
                  if (event.type === 'call_started') heartbeat.updateCallId(event.callId);
                  publishRunnerCallEvent({ bus, phase: state.phase, rootDir: projectDir }, event);
                },
              },
            );
            return asked.result;
          } finally {
            heartbeat.stop();
          }
        },
      });
      // `onStateChange` already moved `state` with the loop, and the call may have moved it since:
      // an expired thread resets the session it names, and an answer saves the handle it returned.
      note = '';
      standingHeard = true;
      images = [];
      priorMessages = undefined;
      const answered = loop.value;
      state = addUsageAndSave(wctx, state, 'planner', answered.usage);
      return answered;
    };

    const answer = async (
      questions: readonly ClarificationQuestion[],
      round: number,
    ): Promise<UserMessageInput | PlannerReplyAnswer | undefined> => {
      let asked = sessionConversation(state);
      if (asked === undefined || asked.answered) {
        asked = {
          call: 'plan',
          text: questionsText(questions),
          questions: [...questions],
          answers: asked?.answers ?? [],
          answered: false,
          ...(fullStanding !== '' && { lead: fullStanding }),
        };
        state = transitionAndSave(ref, state, {
          type: 'SET_PLANNER_CONVERSATION',
          conversation: asked,
        });
        const intro = `Questions before the plan · round ${round} of ${MAX_QUESTION_ROUNDS}`;
        appendMessage(ref, { role: 'assistant', phase: state.phase, text: intro });
        createBusTextHandler({ bus, phase: state.phase }, { role: 'planner', content: 'plain' })(
          intro,
          { messageStart: true },
        );
      }
      if (resumedAnswer !== undefined) {
        const reply = resumedAnswer;
        resumedAnswer = undefined;
        return { message: reply, qa: [] };
      }
      const asking = await askOperator(wctx, state, asked);
      state = asking.state;
      return asking.reply;
    };

    const outcome = await runPlanSession({
      rounds: rounds(),
      ...(pending !== undefined && !pending.answered && { pending: pending.questions }),
      ask,
      answer,
      check: (plan) => checkFullPlan(wctx, plan),
    });
    if (outcome.kind === 'plan' && outcome.checksRepaired) {
      publishInfo({ bus, phase: state.phase, message: 'The revised plan passes its checks.' });
    }
    return await settle(opts, state, outcome);
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }
}
