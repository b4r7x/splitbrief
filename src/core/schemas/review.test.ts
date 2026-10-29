import { describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import {
  REVIEW_VERDICT_JSON_SCHEMA,
  ReviewVerdictSchema,
  ReviewAnswerSchema,
  REVIEW_ANSWER_JSON_SCHEMA,
  TriageInputSchema,
  TriageResultSchema,
} from './review.js';

const verdict = {
  tasks: [{ id: 'T001', plan: 'met', note: 'The module and its test are present' }],
  criteria: [{ id: 'C1', status: 'pass', evidence: 'src/hello.test.ts passes' }],
  findings: [
    {
      id: 'F1',
      kind: 'defect',
      severity: 'minor',
      taskId: null,
      file: 'src/hello.ts',
      line: 3,
      text: 'The greeting drops an empty name',
      acceptance: 'An empty name still gets the default greeting',
      checkIds: null,
      criterionId: null,
    },
  ],
};

describe('ReviewVerdictSchema', () => {
  it('parses a complete verdict', () => {
    expect(ReviewVerdictSchema.parse(verdict)).toEqual(verdict);
  });

  it('refuses an unknown plan, criterion status and finding severity', () => {
    const badPlan = { ...verdict, tasks: [{ id: 'T001', plan: 'done', note: '' }] };
    expect(ReviewVerdictSchema.safeParse(badPlan).success).toBe(false);
    const badStatus = { ...verdict, criteria: [{ id: 'C1', status: 'unknown', evidence: '' }] };
    expect(ReviewVerdictSchema.safeParse(badStatus).success).toBe(false);
    const badSeverity = {
      ...verdict,
      findings: [{ ...verdict.findings[0], severity: 'critical' }],
    };
    expect(ReviewVerdictSchema.safeParse(badSeverity).success).toBe(false);
  });
});

describe('TriageResultSchema', () => {
  it('parses fix tasks with their findings, rejected findings, verify entries and no ask', () => {
    const result = {
      fixTasks: [{ ...makeTaskSpec(), findingIds: ['F1'] }],
      rejected: [{ findingId: 'F2', reason: 'The finding names no file of the run diff' }],
      verify: [{ findingId: 'F3', checkIds: ['K1'] }],
      ask: null,
    };
    expect(TriageResultSchema.parse(result)).toEqual(result);
  });

  it('parses an ask and refuses a fix task with no finding and a verify with no check', () => {
    const ask = {
      fixTasks: [],
      rejected: [],
      verify: [],
      ask: {
        question: 'Should the greeting keep the comma?',
        whyOnlyUserCanAnswer: 'The answer changes the product wording',
      },
    };
    expect(TriageResultSchema.parse(ask)).toEqual(ask);
    const noFinding = { fixTasks: [makeTaskSpec()], rejected: [], verify: [], ask: null };
    expect(TriageResultSchema.safeParse(noFinding).success).toBe(false);
    const noCheck = {
      fixTasks: [],
      rejected: [],
      verify: [{ findingId: 'F1', checkIds: [] }],
      ask: null,
    };
    expect(TriageResultSchema.safeParse(noCheck).success).toBe(false);
  });
});

describe('TriageInputSchema', () => {
  it('parses an operator correction, an apply conflict and a failed check', () => {
    const correction = {
      id: 'I1',
      kind: 'defect',
      source: 'user',
      text: 'Use the shared greeting helper',
      file: 'src/hello.ts',
    };
    expect(TriageInputSchema.parse(correction)).toEqual(correction);
    const conflict = {
      id: 'I2',
      kind: 'question',
      source: 'apply',
      text: 'The merged file keeps both greetings',
      file: null,
    };
    expect(TriageInputSchema.parse(conflict)).toEqual(conflict);
    const failedCheck = {
      id: 'I3',
      kind: 'answer',
      source: 'check',
      text: 'The verification failed',
      file: 'src/hello.test.ts',
    };
    expect(TriageInputSchema.parse(failedCheck)).toEqual(failedCheck);
  });
});

describe('review JSON schemas', () => {
  it('compose no allOf, which a closed object makes unsatisfiable', () => {
    expect(JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA)).not.toContain('allOf');
    expect(JSON.stringify(REVIEW_ANSWER_JSON_SCHEMA)).not.toContain('allOf');
  });

  it('strips the draft ref and keeps a root object', () => {
    expect(REVIEW_VERDICT_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(REVIEW_ANSWER_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(REVIEW_VERDICT_JSON_SCHEMA.type).toBe('object');
    expect(REVIEW_ANSWER_JSON_SCHEMA.type).toBe('object');
  });
});

describe('ReviewAnswerSchema', () => {
  it('requires the verdict and fix work in one answer and preserves both persisted shapes', () => {
    const fix = { fixTasks: [], rejected: [], verify: [], ask: null };
    const answer = { ...verdict, ...fix };
    expect(ReviewAnswerSchema.parse(answer)).toEqual(answer);
    expect(ReviewAnswerSchema.safeParse(verdict).success).toBe(false);
    expect(ReviewVerdictSchema.parse(answer)).toEqual(verdict);
    expect(TriageResultSchema.parse(answer)).toEqual(fix);
  });
});
