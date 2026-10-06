import { describe, expect, it, vi } from 'vitest';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import type { PlanAnswer, PlanResult } from '../../../core/schemas/plan.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { typedOutputError, type RequestTypedResult } from '../../runners/typed-output.js';
import type { PlanCheckError } from '../../spec/plan-checks.js';
import { runPlanSession, type PlanTurn } from './plan-session.js';

const questions = (round: number): PlanResult => ({
  kind: 'questions',
  questions: [
    { id: `q${round}a`, text: `Round ${round}: which module?`, choices: null, default: 'src/a.ts' },
    {
      id: `q${round}b`,
      text: `Round ${round}: which style?`,
      choices: ['terse', 'verbose'],
      default: 'terse',
    },
  ],
});

const answer = (result: PlanResult): RequestTypedResult<PlanAnswer> => ({
  value: { result },
  nativeSessionId: 'thread-1',
  usage: null,
});

const uncovered: PlanCheckError = {
  code: 'uncovered-criterion',
  message: 'Criterion C2 is served by no task.',
};

const unconfiguredRender: PlanCheckError = {
  code: 'render-check-unconfigured',
  message:
    'Render check K-render needs validation.render, which is not set; drop it or ask the user.',
};

function scripted(results: RequestTypedResult<PlanAnswer>[]) {
  const turns: PlanTurn[] = [];
  const ask = vi.fn(async (turn: PlanTurn) => {
    turns.push(turn);
    const next = results.shift();
    if (next === undefined) throw new Error('the planner was asked once too often');
    return next;
  });
  return { ask, turns };
}

describe('runPlanSession', () => {
  it('takes every default on an empty reply and returns the plan the answers lead to', async () => {
    const plan = makePlanProposal();
    const { ask, turns } = scripted([answer(questions(1)), answer(plan)]);
    const asked: ClarificationQuestion[][] = [];

    const outcome = await runPlanSession({
      rounds: 0,
      ask,
      answer: async (qs) => {
        asked.push([...qs]);
        return '';
      },
      check: async () => [],
    });

    expect(outcome).toEqual({ kind: 'plan', plan });
    expect(asked[0]).toEqual([
      { id: 'q1a', type: 'input', text: 'Round 1: which module?', default: 'src/a.ts' },
      {
        id: 'q1b',
        type: 'choice',
        text: 'Round 1: which style?',
        options: ['terse', 'verbose'],
        default: 'terse',
      },
    ]);
    expect(turns[1]).toEqual({
      kind: 'answers',
      reply: {
        text: '1. Round 1: which module?\nsrc/a.ts\n\n2. Round 1: which style?\nterse',
        qa: [
          { question: 'Round 1: which module?', answer: 'src/a.ts' },
          { question: 'Round 1: which style?', answer: 'terse' },
        ],
      },
    });
  });

  it('accepts two rounds of questions and halts on the third', async () => {
    const { ask } = scripted([answer(questions(1)), answer(questions(2)), answer(questions(3))]);
    const rounds: number[] = [];

    const outcome = await runPlanSession({
      rounds: 0,
      ask,
      answer: async (_qs, round) => {
        rounds.push(round);
        return '';
      },
      check: async () => [],
    });

    expect(rounds).toEqual([1, 2]);
    expect(outcome).toMatchObject({ kind: 'questions-exhausted' });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('counts the rounds a resumed session already answered', async () => {
    const { ask } = scripted([answer(questions(3))]);
    const outcome = await runPlanSession({
      rounds: 2,
      ask,
      answer: async () => '',
      check: async () => [],
    });
    expect(outcome).toMatchObject({ kind: 'questions-exhausted' });
  });

  it('answers the questions a resumed session left pending before it asks again', async () => {
    const plan = makePlanProposal();
    const { ask, turns } = scripted([answer(plan)]);
    const pending: ClarificationQuestion[] = [
      { id: 'q', type: 'input', text: 'Which module?', default: 'src/a.ts' },
    ];

    const outcome = await runPlanSession({
      rounds: 0,
      pending,
      ask,
      answer: async () => ({
        text: 'src/b.ts',
        qa: [{ question: 'Which module?', answer: 'src/b.ts' }],
      }),
      check: async () => [],
    });

    expect(outcome).toEqual({ kind: 'plan', plan });
    expect(turns).toEqual([
      {
        kind: 'answers',
        reply: { text: 'src/b.ts', qa: [{ question: 'Which module?', answer: 'src/b.ts' }] },
      },
    ]);
  });

  it('stops when nobody answers the questions', async () => {
    const { ask } = scripted([answer(questions(1))]);
    const outcome = await runPlanSession({
      rounds: 0,
      ask,
      answer: async () => undefined,
      check: async () => [],
    });
    expect(outcome).toMatchObject({ kind: 'unanswered' });
  });

  it('sends a plan that fails its checks back once and returns the corrected plan', async () => {
    const invalid = makePlanProposal({ summary: 'first' });
    const corrected = makePlanProposal({ summary: 'second' });
    const { ask, turns } = scripted([answer(invalid), answer(corrected)]);
    const check = vi.fn(async (plan: typeof invalid) => (plan === invalid ? [uncovered] : []));

    const outcome = await runPlanSession({ rounds: 0, ask, answer: async () => '', check });

    expect(outcome).toEqual({ kind: 'plan', plan: corrected });
    expect(turns[1]).toEqual({ kind: 'repair', errors: [uncovered], plan: invalid });
  });

  it('halts on a second plan that fails its checks', async () => {
    const { ask } = scripted([answer(makePlanProposal()), answer(makePlanProposal())]);
    const outcome = await runPlanSession({
      rounds: 0,
      ask,
      answer: async () => '',
      check: async () => [uncovered],
    });
    expect(outcome).toEqual({ kind: 'checks-failed', errors: [uncovered] });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('sends unconfigured render checks back once, then lets the plan reach the card with them', async () => {
    const plan = makePlanProposal();
    const { ask, turns } = scripted([answer(plan), answer(plan)]);
    const outcome = await runPlanSession({
      rounds: 0,
      ask,
      answer: async () => '',
      check: async () => [unconfiguredRender],
    });
    expect(turns[1]).toEqual({ kind: 'repair', errors: [unconfiguredRender], plan });
    expect(outcome).toEqual({ kind: 'plan', plan });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('halts on a second plan that still fails a blocking check beside an unconfigured render check', async () => {
    const { ask } = scripted([answer(makePlanProposal()), answer(makePlanProposal())]);
    const outcome = await runPlanSession({
      rounds: 0,
      ask,
      answer: async () => '',
      check: async () => [uncovered, unconfiguredRender],
    });
    expect(outcome).toEqual({ kind: 'checks-failed', errors: [uncovered, unconfiguredRender] });
  });

  it('hands a seat protocol error back without another call', async () => {
    const error = typedOutputError.seatProtocol({
      seat: 'planner',
      attempts: 2,
      transport: 'native',
      errors: 'result: Invalid input',
      answerPreview: '{}',
    });
    const { ask } = scripted([{ error, usage: null }]);
    const outcome = await runPlanSession({
      rounds: 0,
      ask,
      answer: async () => '',
      check: async () => [],
    });
    expect(outcome).toEqual({ kind: 'seat-protocol', error });
  });
});
