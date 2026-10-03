import { describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import {
  CONSULT_ANSWER_JSON_SCHEMA,
  ConsultAnswerSchema,
  ImplementerReportSchema,
  StaleConsultAnswerSchema,
} from './consult.js';

const answer = (action: Record<string, unknown>) => ({
  answer: { diagnosis: 'The helper returns the wrong type', ...action },
});

describe('ConsultAnswerSchema', () => {
  it('parses each action', () => {
    const actions = [
      { action: 'guidance', instructions: 'Narrow the return type', context: null },
      { action: 'rewrite-task', task: makeTaskSpec() },
      { action: 'split-task', tasks: [makeTaskSpec(), makeTaskSpec({ id: 'T002' })] },
      { action: 'verify', checkIds: ['K1'], reason: 'The check reads the wrong path' },
      {
        action: 'ask-user',
        question: 'Which store should the cache use?',
        whyOnlyUserCanAnswer: 'The choice changes the deployment',
        choices: ['redis', 'memory'],
        default: 'memory',
      },
    ];
    for (const action of actions) {
      expect(ConsultAnswerSchema.parse(answer(action))).toMatchObject({ answer: action });
    }
  });

  it('refuses a split-task with one or five tasks', () => {
    const one = answer({ action: 'split-task', tasks: [makeTaskSpec()] });
    expect(ConsultAnswerSchema.safeParse(one).success).toBe(false);
    const five = Array.from({ length: 5 }, (_, index) => makeTaskSpec({ id: `T00${index + 1}` }));
    expect(
      ConsultAnswerSchema.safeParse(answer({ action: 'split-task', tasks: five })).success,
    ).toBe(false);
  });

  it('strips the draft ref and keeps a root object', () => {
    expect(CONSULT_ANSWER_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(CONSULT_ANSWER_JSON_SCHEMA.type).toBe('object');
  });
});

describe('StaleConsultAnswerSchema', () => {
  it('takes guidance and rewrite-task but not split-task', () => {
    const guidance = answer({ action: 'guidance', instructions: 'Narrow it', context: null });
    expect(StaleConsultAnswerSchema.safeParse(guidance).success).toBe(true);
    const rewrite = answer({ action: 'rewrite-task', task: makeTaskSpec() });
    expect(StaleConsultAnswerSchema.safeParse(rewrite).success).toBe(true);
    const split = answer({
      action: 'split-task',
      tasks: [makeTaskSpec(), makeTaskSpec({ id: 'T002' })],
    });
    expect(StaleConsultAnswerSchema.safeParse(split).success).toBe(false);
  });
});

describe('ImplementerReportSchema', () => {
  it('accepts a done report and a blocked report', () => {
    const done = {
      status: 'done',
      filesChanged: ['src/hello.ts'],
      touchedNotSuggested: [{ file: 'src/hello.test.ts', reason: 'The check needed a fixture' }],
      notes: null,
    };
    expect(ImplementerReportSchema.parse(done)).toEqual(done);
    const blocked = {
      status: 'blocked',
      question: 'Which store should the cache use?',
      filesNeeded: ['src/store.ts'],
    };
    expect(ImplementerReportSchema.parse(blocked)).toEqual(blocked);
  });
});
