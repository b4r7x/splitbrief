import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  CONSULT_ANSWER_JSON_SCHEMA,
  ConsultAnswerSchema,
  DEVIATION_CONSULT_ANSWER_JSON_SCHEMA,
  DeviationConsultAnswerSchema,
  ImplementerReportSchema,
  STALE_CONSULT_ANSWER_JSON_SCHEMA,
  StaleConsultAnswerSchema,
} from './consult.js';
import { PLAN_ANSWER_JSON_SCHEMA } from './plan.js';

const answer = (action: Record<string, unknown>) => ({
  answer: { diagnosis: 'The helper returns the wrong type', ...action },
});

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

function hasAllOf(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasAllOf);
  if (!isRecord(node)) return false;
  return 'allOf' in node || Object.values(node).some(hasAllOf);
}

function answerVariants(jsonSchema: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const answerNode = isRecord(jsonSchema.properties) ? jsonSchema.properties.answer : undefined;
  if (!isRecord(answerNode)) throw new Error('the schema has no answer property');
  const variants = answerNode.oneOf ?? answerNode.anyOf;
  if (!Array.isArray(variants)) throw new Error('the answer node is not a oneOf or anyOf');
  return variants.filter(isRecord);
}

function variantFor(
  jsonSchema: Readonly<Record<string, unknown>>,
  action: string,
): Record<string, unknown> | undefined {
  return answerVariants(jsonSchema).find(
    (variant) =>
      isRecord(variant.properties) &&
      isRecord(variant.properties.action) &&
      variant.properties.action.const === action,
  );
}

describe('ConsultAnswerSchema', () => {
  it('parses each action', () => {
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

describe('DeviationConsultAnswerSchema', () => {
  const takes = (value: unknown): boolean => DeviationConsultAnswerSchema.safeParse(value).success;
  const confirm = answer({
    action: 'confirm',
    decisions: [{ what: 'Used node:crypto', why: 'The dependency is standard' }],
  });

  it('takes confirm, guidance, rewrite-task and ask-user but not split-task or verify', () => {
    expect(takes(confirm)).toBe(true);
    expect(takes(answer({ action: 'guidance', instructions: 'Narrow it', context: null }))).toBe(
      true,
    );
    expect(takes(answer({ action: 'rewrite-task', task: makeTaskSpec() }))).toBe(true);
    expect(
      takes(
        answer({
          action: 'ask-user',
          question: 'Keep it?',
          whyOnlyUserCanAnswer: 'It changes what is built',
          choices: null,
          default: null,
        }),
      ),
    ).toBe(true);
    expect(
      takes(
        answer({ action: 'split-task', tasks: [makeTaskSpec(), makeTaskSpec({ id: 'T002' })] }),
      ),
    ).toBe(false);
    expect(takes(answer({ action: 'verify', checkIds: ['K1'], reason: 'Stale check' }))).toBe(
      false,
    );
  });
});

describe('consult answer JSON schemas', () => {
  const schemas = [
    { name: 'consult', jsonSchema: CONSULT_ANSWER_JSON_SCHEMA, accepted: actions },
    {
      name: 'stale consult',
      jsonSchema: STALE_CONSULT_ANSWER_JSON_SCHEMA,
      accepted: actions.filter(({ action }) => action === 'guidance' || action === 'rewrite-task'),
    },
  ];

  for (const { name, jsonSchema, accepted } of schemas) {
    it(`admits every valid ${name} answer in one closed variant`, () => {
      for (const action of accepted) {
        const value = answer(action).answer;
        const variant = variantFor(jsonSchema, action.action);
        expect(variant, action.action).toBeDefined();
        expect(variant?.additionalProperties).toBe(false);
        expect(Object.keys(isRecord(variant?.properties) ? variant.properties : {}).sort()).toEqual(
          Object.keys(value).sort(),
        );
        expect(Array.isArray(variant?.required) ? [...variant.required].sort() : []).toEqual(
          Object.keys(value).sort(),
        );
      }
    });
  }

  it('offers the stale consult only guidance and rewrite-task', () => {
    expect(variantFor(STALE_CONSULT_ANSWER_JSON_SCHEMA, 'split-task')).toBeUndefined();
    expect(answerVariants(STALE_CONSULT_ANSWER_JSON_SCHEMA)).toHaveLength(2);
  });
});

describe('typed seat contracts', () => {
  it('compose no allOf, which a closed object makes unsatisfiable', () => {
    const contracts = {
      consult: CONSULT_ANSWER_JSON_SCHEMA,
      staleConsult: STALE_CONSULT_ANSWER_JSON_SCHEMA,
      deviationConsult: DEVIATION_CONSULT_ANSWER_JSON_SCHEMA,
      plan: PLAN_ANSWER_JSON_SCHEMA,
      implementerReport: z.toJSONSchema(ImplementerReportSchema),
    };
    for (const [name, jsonSchema] of Object.entries(contracts)) {
      expect(hasAllOf(jsonSchema), name).toBe(false);
    }
  });

  it('offers the deviation consult the confirm action as one closed variant', () => {
    const variant = variantFor(DEVIATION_CONSULT_ANSWER_JSON_SCHEMA, 'confirm');
    expect(variant).toBeDefined();
    expect(variant?.additionalProperties).toBe(false);
    expect(variantFor(DEVIATION_CONSULT_ANSWER_JSON_SCHEMA, 'split-task')).toBeUndefined();
  });
});

describe('ImplementerReportSchema', () => {
  it('accepts a done report and a blocked report', () => {
    const done = {
      status: 'done',
      filesChanged: ['src/hello.ts'],
      touchedNotSuggested: [{ file: 'src/hello.test.ts', reason: 'The check needed a fixture' }],
      notes: null,
      decisions: [],
    };
    expect(ImplementerReportSchema.parse(done)).toEqual(done);
    const blocked = {
      status: 'blocked',
      question: 'Which store should the cache use?',
      filesNeeded: ['src/store.ts'],
    };
    expect(ImplementerReportSchema.parse(blocked)).toEqual(blocked);
  });

  it('defaults a missing decision list to empty and a missing reason to empty text', () => {
    const done = {
      status: 'done',
      filesChanged: ['src/hello.ts'],
      touchedNotSuggested: [{ file: 'src/hello.test.ts' }],
      notes: null,
    };
    expect(ImplementerReportSchema.parse(done)).toEqual({
      ...done,
      touchedNotSuggested: [{ file: 'src/hello.test.ts', reason: '' }],
      decisions: [],
    });
  });

  it('parses a reported decision as what the implementer did and why', () => {
    const done = {
      status: 'done',
      filesChanged: ['src/hello.ts'],
      touchedNotSuggested: [],
      notes: null,
      decisions: [{ what: 'Used node:crypto', why: 'The dependency is standard' }],
    };
    expect(ImplementerReportSchema.parse(done)).toEqual(done);
  });
});
