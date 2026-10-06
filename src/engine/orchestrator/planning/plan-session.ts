import type { PlanAnswer, PlanProposal, PlanResult } from '../../../core/schemas/plan.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { RequestTypedResult, SeatProtocolError } from '../../runners/typed-output.js';
import { blocksPlan, type PlanCheckError } from '../../spec/plan-checks.js';
import { MAX_QUESTION_ROUNDS } from '../../spec/prompts/plan-session.js';

/** What the next planner call of the session carries. */
export type PlanTurn =
  | Readonly<{ kind: 'open' }>
  | Readonly<{ kind: 'answers'; reply: PlannerReplyAnswer }>
  | Readonly<{ kind: 'repair'; errors: readonly PlanCheckError[]; plan: PlanProposal }>;

export type PlanSessionOutcome =
  | Readonly<{ kind: 'plan'; plan: PlanProposal }>
  | Readonly<{ kind: 'questions-exhausted'; questions: readonly ClarificationQuestion[] }>
  | Readonly<{ kind: 'checks-failed'; errors: readonly PlanCheckError[] }>
  | Readonly<{ kind: 'seat-protocol'; error: SeatProtocolError }>;

/** A session whose questions nobody answered; only a session that can leave them open ends so. */
export type PlanSessionUnanswered = Readonly<{ kind: 'unanswered' }>;

type PlanReply = string | PlannerReplyAnswer;

export type PlanSessionIo<Reply extends PlanReply | undefined> = Readonly<{
  /** Question rounds the session already answered. */
  rounds: number;
  /** Questions a stopped session left without an answer. */
  pending?: readonly ClarificationQuestion[] | undefined;
  ask: (turn: PlanTurn) => Promise<RequestTypedResult<PlanAnswer>>;
  /** The reply to one round; undefined when nobody answers it. */
  answer: (questions: readonly ClarificationQuestion[], round: number) => Promise<Reply>;
  check: (plan: PlanProposal) => Promise<readonly PlanCheckError[]>;
}>;

function clarificationQuestions(
  result: Extract<PlanResult, { kind: 'questions' }>,
): ClarificationQuestion[] {
  return result.questions.map((question) =>
    question.choices !== null && question.choices.length > 0
      ? {
          id: question.id,
          type: 'choice',
          text: question.text,
          options: question.choices,
          default: question.default,
        }
      : { id: question.id, type: 'input', text: question.text, default: question.default },
  );
}

function defaultAnswer(question: ClarificationQuestion): string {
  if (typeof question.default === 'boolean') return question.default ? 'Yes' : 'No';
  return question.default ?? '';
}

/** An empty reply takes every default; a typed reply stands as it was written. */
function replyFor(
  questions: readonly ClarificationQuestion[],
  reply: string | PlannerReplyAnswer,
): PlannerReplyAnswer {
  if (typeof reply !== 'string') return reply;
  if (reply.trim() !== '') return { text: reply, qa: [] };
  const qa = questions.map((question) => ({
    question: question.text,
    answer: defaultAnswer(question),
  }));
  return {
    text: qa.map((pair, index) => `${index + 1}. ${pair.question}\n${pair.answer}`).join('\n\n'),
    qa,
  };
}

/**
 * One planning session: questions in at most two rounds, then a plan that passes the checks.
 * A plan that fails them goes back once with the errors; the transport repair inside `ask` is the
 * typed call's own and never counts here.
 */
export function runPlanSession(io: PlanSessionIo<PlanReply>): Promise<PlanSessionOutcome>;
export function runPlanSession(
  io: PlanSessionIo<PlanReply | undefined>,
): Promise<PlanSessionOutcome | PlanSessionUnanswered>;
export async function runPlanSession(
  io: PlanSessionIo<PlanReply | undefined>,
): Promise<PlanSessionOutcome | PlanSessionUnanswered> {
  let rounds = io.rounds;
  let pending = io.pending;
  let repaired = false;
  let turn: PlanTurn = { kind: 'open' };

  while (true) {
    if (pending !== undefined) {
      const reply = await io.answer(pending, rounds + 1);
      if (reply === undefined) return { kind: 'unanswered' };
      rounds += 1;
      turn = { kind: 'answers', reply: replyFor(pending, reply) };
      pending = undefined;
    }

    const answered = await io.ask(turn);
    if ('error' in answered) return { kind: 'seat-protocol', error: answered.error };
    const { result } = answered.value;

    if (result.kind === 'questions') {
      const questions = clarificationQuestions(result);
      if (rounds >= MAX_QUESTION_ROUNDS) return { kind: 'questions-exhausted', questions };
      pending = questions;
      continue;
    }

    const errors = await io.check(result);
    if (errors.length === 0) return { kind: 'plan', plan: result };
    if (repaired) {
      return errors.every((error) => !blocksPlan(error))
        ? { kind: 'plan', plan: result }
        : { kind: 'checks-failed', errors };
    }
    repaired = true;
    turn = { kind: 'repair', errors, plan: result };
  }
}
