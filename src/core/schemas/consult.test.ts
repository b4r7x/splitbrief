import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  CONSULT_ANSWER_JSON_SCHEMA,
  ConsultAnswerSchema,
  consultAnswerSchemaFor,
  ImplementerReportSchema,
  readImplementerReport,
} from './consult.js';
import { PLAN_ANSWER_JSON_SCHEMA } from './plan.js';
import { taskId } from './task.js';

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

  it('refuses the retired confirm action', () => {
    expect(
      ConsultAnswerSchema.safeParse(answer({ action: 'confirm', decisionIds: ['d1'] })).success,
    ).toBe(false);
  });

  it('splits a subtask only when the split replaces the next fix briefs of a stuck review', () => {
    const subtask = makeTask({ id: 'T003', parentId: taskId('T002') });
    const split = answer({
      action: 'split-task',
      tasks: [makeTaskSpec({ id: 'T004' }), makeTaskSpec({ id: 'T005' })],
    });
    expect(consultAnswerSchemaFor(subtask, 'no-progress').safeParse(split).success).toBe(true);
    const refused = consultAnswerSchemaFor(subtask, 'failed').safeParse(split);
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
      'T003 is already a subtask of a split and cannot be split again',
    ]);
  });

  it('strips the draft ref and keeps a root object', () => {
    expect(CONSULT_ANSWER_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(CONSULT_ANSWER_JSON_SCHEMA.type).toBe('object');
  });
});

describe('consult answer JSON schema', () => {
  it('admits every valid consult answer in one closed variant', () => {
    for (const action of actions) {
      const value = answer(action).answer;
      const variant = variantFor(CONSULT_ANSWER_JSON_SCHEMA, action.action);
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
});

describe('typed seat contracts', () => {
  it('compose no allOf, which a closed object makes unsatisfiable', () => {
    const contracts = {
      consult: CONSULT_ANSWER_JSON_SCHEMA,
      plan: PLAN_ANSWER_JSON_SCHEMA,
      implementerReport: z.toJSONSchema(ImplementerReportSchema),
    };
    for (const [name, jsonSchema] of Object.entries(contracts)) {
      expect(hasAllOf(jsonSchema), name).toBe(false);
    }
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

describe('readImplementerReport', () => {
  const done = {
    status: 'done',
    filesChanged: ['src/hello.ts'],
    touchedNotSuggested: [],
    notes: 'Wired the export.',
    decisions: [{ what: 'Used node:crypto', why: 'The dependency is standard' }],
  };

  it('reads a valid report as it is', () => {
    expect(readImplementerReport(done)).toEqual({ report: done, dropped: [] });
  });

  it('reads a decision written as text as a decision with no reason', () => {
    expect(readImplementerReport({ ...done, decisions: ['Kept the old name'] })).toEqual({
      report: { ...done, decisions: [{ what: 'Kept the old name', why: null }] },
      dropped: [],
    });
  });

  it('keeps every valid field of a done report and names each field it drops', () => {
    expect(
      readImplementerReport({ ...done, touchedNotSuggested: 'none', notes: undefined }),
    ).toEqual({
      report: { ...done, touchedNotSuggested: [], notes: null },
      dropped: ['touchedNotSuggested', 'notes'],
    });
  });

  it('reads no report without a status it knows, and no blocked report with a bad field', () => {
    expect(readImplementerReport({ ...done, status: 'finished' })).toBeUndefined();
    expect(readImplementerReport('done')).toBeUndefined();
    expect(
      readImplementerReport({ status: 'blocked', question: 7, filesNeeded: [] }),
    ).toBeUndefined();
  });
});
