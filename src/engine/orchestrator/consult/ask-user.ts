import { DECIDE_YOURSELF_ANSWER } from '../../../core/recovery/decide.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { Task } from '../../../core/schemas/task.js';
import type { PlannerConversation } from '../../../core/schemas/workflow/state.js';
import { briefCorrections } from '../../../core/state/lineage.js';
import { type UserMessageInput, plainUserMessage } from '../../../core/types/user-input.js';
import { askOperator } from '../planning/call-loop.js';
import { recordBriefCorrection } from '../state-ops/corrections.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { recordUserMessage } from '../transcript/user-message.js';
import type { AskUserAction, ConsultApplyContext, ConsultApplyOutcome } from './types.js';

const ASK_USER_QUESTION_ID = 'ask-user';

/**
 * The question the user sees: the brief's operator instructions, then the planner's question next to
 * its choices, so the user sees which of their own instructions the question concerns.
 */
function askUserQuestion(
  action: AskUserAction,
  taskId: string,
  instructions: readonly string[],
): ClarificationQuestion {
  const text =
    instructions.length === 0
      ? action.question
      : [
          `Your instructions for ${taskId}:`,
          ...instructions.map((instruction) => `- ${instruction.replaceAll('\n', '\n  ')}`),
          '',
          action.question,
        ].join('\n');
  if (action.choices !== null && action.choices.length > 0) {
    return {
      id: ASK_USER_QUESTION_ID,
      type: 'choice',
      text,
      options: action.choices,
      ...(action.default !== null && { default: action.default }),
    };
  }
  return {
    id: ASK_USER_QUESTION_ID,
    type: 'input',
    text,
    ...(action.default !== null && { default: action.default }),
  };
}

function defaultAnswer(question: ClarificationQuestion): string {
  if (typeof question.default === 'boolean') return question.default ? 'Yes' : 'No';
  return question.default ?? DECIDE_YOURSELF_ANSWER;
}

export function consultReplyAnswer(
  question: ClarificationQuestion,
  reply: UserMessageInput | PlannerReplyAnswer | undefined,
): PlannerReplyAnswer {
  const message = reply === undefined ? undefined : 'message' in reply ? reply.message : reply;
  if (message === undefined || message.text.trim() === '') {
    const text = defaultAnswer(question);
    return {
      message: plainUserMessage(text),
      qa: [{ question: question.text, answer: text }],
    };
  }
  if (reply !== undefined && 'message' in reply) return reply;
  return { message, qa: [{ question: question.text, answer: message.displayText }] };
}

/**
 * Puts the planner's question to the user. The answer joins the brief's operator instructions,
 * so every later call on the brief, build or consult, reads it with the user's corrections.
 */
export async function applyAskUser(
  ctx: ConsultApplyContext,
  task: Task,
  action: AskUserAction,
): Promise<ConsultApplyOutcome> {
  const question = askUserQuestion(action, task.id, briefCorrections(ctx.state, task.id));
  const asked: PlannerConversation = {
    call: 'plan',
    text: action.question,
    questions: [question],
    answers: [],
    answered: false,
  };
  const asking = await askOperator(ctx, ctx.state, asked);
  const reply = asking.reply;
  if (reply === undefined && question.default === undefined)
    return { action: 'unanswered', question: action.question };
  const answered = consultReplyAnswer(question, reply);
  // The transcript and the brief's log keep the planner's question; the instructions were context.
  const qa = answered.qa.map((pair) => ({ question: action.question, answer: pair.answer }));
  const recorded = transitionAndSave(ctx, asking.state, {
    type: 'SET_PLANNER_CONVERSATION',
    conversation: {
      ...asked,
      answered: true,
      answers: [{ reply: asked.text, answer: answered.message.text }],
    },
  });
  const cleared = transitionAndSave(ctx, recorded, { type: 'CLEAR_PLANNER_CONVERSATION' });
  recordUserMessage({ ...ctx, phase: cleared.phase }, answered.message, {
    qa,
    answerIndex: (cleared.userAnswers?.length ?? 0) - 1,
  });
  const instructed = recordBriefCorrection(
    ctx,
    cleared,
    task.id,
    qa.map((pair) => `Question: ${pair.question}\nAnswer: ${pair.answer}`).join('\n\n'),
  );
  ctx.onStateChange?.(instructed);
  return { action: 'guidance', instructions: answered.message.text, context: null };
}
