import {
  PLAN_ANSWER_JSON_SCHEMA,
  PlanAnswerSchema,
  type PlanAnswer,
} from '../../../core/schemas/plan.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { questionsText, sessionConversation } from '../../../core/state/planning-conversation.js';
import { appendMessage } from '../../../core/sessions/log/writer.js';
import { createLogger } from '../../../lib/logger.js';
import type { Planner, PriorMessage } from '../../planners/types.js';
import type { RequestTypedResult } from '../../runners/typed-output.js';
import { planRepairWarning } from '../../spec/plan/checks.js';
import {
  MAX_QUESTION_ROUNDS,
  planAnswersTurn,
  questionRoundLimit,
  planFullTurn,
  planRepairTurn,
} from '../../spec/prompts/plan-session.js';
import { withContinuationLoop, type ContinuationLoopBodyArgs } from '../continuation/loop.js';
import { createBusTextHandler, publishRunnerCallEvent } from '../publish/runner.js';
import { askPlannerSession } from '../planner-session.js';
import { imagesFromMessages } from '../queue/prompt.js';
import { addUsageAndSave } from '../state-ops/usage.js';
import { transitionAndSave } from '../state-ops/transition.js';
import type { PlannerCallbacksContext } from '../types.js';
import { recordAnswers } from './answers.js';
import { askOperator } from './call-loop.js';
import { startPlannerHeartbeat } from './heartbeat.js';
import type { PlanTurn } from './plan-session.js';
import { drainAndFormat } from './queue-drain.js';
import type { PlanTurnText } from './turn-text.js';
import type { PlanningTurnState } from './types.js';

/** What the turns of one planning session read and never change. */
type PlanningTurnInput = {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  lead: string | undefined;
  standing: string;
  fullStanding: string;
  turnText: PlanTurnText;
};

/** What each call of one turn carries: the turn, the queued text drained for it and its images. */
type TurnCall = {
  turn: PlanTurn;
  note: string;
  images: Attachment[];
};

async function composeTurn(
  input: PlanningTurnInput,
  shared: PlanningTurnState,
  call: TurnCall,
  onSession: boolean,
  interruptSteer: string | undefined,
  prior: readonly PriorMessage[] | undefined,
): Promise<string> {
  const { lead, standing } = input;
  const { turn, note } = call;
  const sessionBody = !onSession
    ? undefined
    : turn.kind === 'answers'
      ? planAnswersTurn(
          turn.reply.message.text,
          sessionConversation(shared.state)?.answers.length ?? 0,
          questionRoundLimit(shared.state.decideForMe),
        )
      : turn.kind === 'repair'
        ? planRepairTurn(turn.errors)
        : lead !== undefined
          ? ''
          : undefined;
  const opening = sessionBody !== undefined && !shared.standingHeard ? standing : '';
  const said = interruptSteer?.trim() ? interruptSteer : undefined;
  const around = (body: string) =>
    [note, opening, body, said ? `The user says: ${said}` : '']
      .filter((part) => part !== '')
      .join('\n\n');
  if (sessionBody !== undefined) return around(sessionBody);
  return input.turnText(
    (prompt) =>
      around(
        planFullTurn(
          prompt,
          sessionConversation(shared.state)?.answers ?? [],
          turn.kind === 'repair' ? turn : undefined,
          input.fullStanding,
          questionRoundLimit(shared.state.decideForMe),
        ),
      ),
    prior,
  );
}

async function callPlanner(
  input: PlanningTurnInput,
  shared: PlanningTurnState,
  call: TurnCall,
  { signal, steer: interruptSteer, steerInput }: ContinuationLoopBodyArgs,
): Promise<RequestTypedResult<PlanAnswer>> {
  const { wctx, planner } = input;
  const { projectDir, sessionId, bus } = wctx;
  const callImages = imagesFromMessages([
    { images: call.images },
    ...(steerInput === undefined ? [] : [steerInput]),
  ]);
  const heartbeat = startPlannerHeartbeat(bus, shared.state.phase, Date.now());
  try {
    const asked = await askPlannerSession(
      {
        projectDir,
        sessionId,
        bus,
        planner,
        config: wctx.config,
        ...(wctx.steering !== undefined && { steering: wctx.steering }),
        state: shared.state,
        signal,
        onStateChange: (next) => {
          shared.state = next;
        },
      },
      {
        schema: PlanAnswerSchema,
        jsonSchema: PLAN_ANSWER_JSON_SCHEMA,
        schemaName: 'plan_result',
        ...(callImages.length > 0 && { images: callImages }),
        ...(shared.priorMessages !== undefined && { priorMessages: shared.priorMessages }),
        compose: ({ onSession, priorMessages: prior }) =>
          composeTurn(input, shared, call, onSession, interruptSteer, prior),
        onCallEvent: (event) => {
          if (event.type === 'call_started') heartbeat.updateCallId(event.callId);
          publishRunnerCallEvent({ bus, phase: shared.state.phase, rootDir: projectDir }, event);
        },
      },
    );
    return asked.result;
  } finally {
    heartbeat.stop();
  }
}

/**
 * One planner turn: the answer it carries joins the conversation, the queue drains into it, and
 * each call of the turn, again after a stop that continues it, carries the same drained text.
 */
export async function askTurn(
  input: PlanningTurnInput,
  shared: PlanningTurnState,
  turn: PlanTurn,
): Promise<RequestTypedResult<PlanAnswer>> {
  const { wctx } = input;
  const { projectDir, sessionId, bus } = wctx;
  if (turn.kind === 'answers') shared.state = recordAnswers(wctx, shared.state, turn.reply);
  if (turn.kind === 'repair') {
    createLogger('engine').debug('plan_send_back', planRepairWarning(turn.errors));
  }
  const drained = await drainAndFormat(projectDir, sessionId, shared.state, bus);
  shared.state = drained.state;
  const call: TurnCall = {
    turn,
    note: drained.prefix.trim(),
    images: imagesFromMessages([
      { images: shared.images },
      ...drained.messages,
      ...(turn.kind === 'answers' ? [turn.reply.message] : []),
    ]),
  };

  const loop = await withContinuationLoop<RequestTypedResult<PlanAnswer>>({
    ctx: {
      projectDir,
      sessionId,
      callbacks: wctx.callbacks,
      bus,
      signal: wctx.signal,
      sinks: wctx.sinks,
    },
    state: shared.state,
    step: { kind: 'planner', call: 'plan' },
    onStateChange: (next) => {
      shared.state = next;
    },
    body: (args) => callPlanner(input, shared, call, args),
  });
  // `onStateChange` already moved `shared.state` with the loop, and the call may have moved it since:
  // an expired thread resets the session it names, and an answer saves the handle it returned.
  shared.standingHeard = true;
  shared.images = [];
  shared.priorMessages = undefined;
  const answered = loop.value;
  shared.state = addUsageAndSave(wctx, shared.state, 'planner', answered.usage);
  return answered;
}

/**
 * The reply to one question round: the round opens the conversation once, a steer that continued
 * the session answers its open round, and the user answers every other round.
 */
export async function answerRound(
  input: PlanningTurnInput,
  shared: PlanningTurnState,
  questions: readonly ClarificationQuestion[],
  round: number,
): Promise<UserMessageInput | PlannerReplyAnswer | undefined> {
  const { wctx, fullStanding } = input;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  let asked = sessionConversation(shared.state);
  if (asked === undefined || asked.answered) {
    asked = {
      call: 'plan',
      text: questionsText(questions),
      questions: [...questions],
      answers: asked?.answers ?? [],
      answered: false,
      ...(fullStanding !== '' && { lead: fullStanding }),
    };
    shared.state = transitionAndSave(ref, shared.state, {
      type: 'SET_PLANNER_CONVERSATION',
      conversation: asked,
    });
    const intro = `Questions before the plan · round ${round} of ${MAX_QUESTION_ROUNDS}`;
    appendMessage(ref, { role: 'assistant', phase: shared.state.phase, text: intro });
    createBusTextHandler(
      { bus: wctx.bus, phase: shared.state.phase },
      { role: 'planner', content: 'plain' },
    )(intro, { messageStart: true });
  }
  if (shared.resumedAnswer !== undefined) {
    const reply = shared.resumedAnswer;
    shared.resumedAnswer = undefined;
    return { message: reply, qa: [] };
  }
  const asking = await askOperator(wctx, shared.state, asked);
  shared.state = asking.state;
  return asking.reply;
}
