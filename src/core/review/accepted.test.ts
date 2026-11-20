import { describe, expect, it } from 'vitest';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  criterion,
  type Finding,
  finding,
  makeVerdict,
  scope,
  verification,
} from '#testing/helpers/review-verdict.js';
import { countNoun } from '../../utils/pluralize.js';
import type { TriageInput, TriageResult } from '../schemas/review/verdict.js';
import type { ReviewRecord } from '../schemas/workflow/review-record.js';
import type { WorkflowState } from '../schemas/workflow/state.js';
import * as verdictModule from './accepted.js';
import { blockingRedInputs, deriveReviewOutcome, openFindings } from './verdict.js';

describe('what an Accept as is leaves open', () => {
  const REVIEW_AT = '2026-11-13T10:00:00.000Z';
  const EARLIER_REVIEW_AT = '2026-11-13T09:00:00.000Z';
  const NO_ANSWER: TriageResult = { fixTasks: [], rejected: [], ask: null };
  const check = (id: string, extra: Partial<TriageInput> = {}): TriageInput => ({
    id,
    kind: 'defect',
    source: 'check',
    text: `Check ${id} did not pass`,
    file: null,
    ...extra,
  });
  const inputs: TriageInput[] = [
    check('V1.1', {
      checkIds: ['V1'],
      command: 'npm test',
      output: 'RUN v4\nError: 2 specs failed\n',
      file: 'src/a.test.ts',
    }),
    check('V1.2', {
      checkIds: ['V1'],
      command: 'npm test -- src/b.test.ts',
      output: 'RUN v4\nError: 1 spec failed\n',
      file: 'src/b.test.ts',
    }),
    check('P1', { checkIds: ['K004'], output: 'src/a.ts(3,1): TS2322' }),
    check('V2.1', { checkIds: ['V2'], command: 'npm run lint', output: 'lint: 1 error' }),
    { id: 'U1', kind: 'defect', source: 'user', text: 'Rename the helper', file: null },
  ];
  const fixWork: TriageResult = {
    fixTasks: [],
    rejected: [{ findingId: 'V2.1', reason: 'Lint is red at the run base too' }],
    ask: null,
  };
  const earlierFixWork: TriageResult = {
    fixTasks: [],
    rejected: [{ findingId: 'P1', reason: 'The type error is fixed' }],
    ask: null,
  };
  const answered = (reviewAt: string, result: TriageResult) => ({
    reviewAt,
    cycle: 1,
    at: reviewAt,
    inputIds: [],
    result,
  });
  const triage = [answered(EARLIER_REVIEW_AT, earlierFixWork), answered(REVIEW_AT, fixWork)];
  const blocker = (id: string, text: string): Finding =>
    finding({ id, severity: 'blocking', text });

  function judged(
    findings: Finding[],
    pending: readonly TriageInput[] = inputs,
  ): { review: ReviewRecord; state: WorkflowState } {
    const verdict = makeVerdict({ findings });
    const outcome = deriveReviewOutcome(
      verdict,
      scope,
      verification(),
      blockingRedInputs(pending, fixWork),
    );
    const review: ReviewRecord = {
      scope: 'final',
      cycle: 0,
      verdict,
      outcome: outcome.kind,
      verification: [],
      redInputs: outcome.redInputs,
      at: REVIEW_AT,
    };
    const state = makeImplState([], { review, pendingTriage: { inputs: [...pending] }, triage });
    return { review, state };
  }

  it('reads the answer the reviewer recorded for one review, and an empty answer when it recorded none', () => {
    const state = makeImplState([], { triage });

    expect(verdictModule.recordedFixWork).toBeTypeOf('function');
    expect(verdictModule.recordedFixWork(state, REVIEW_AT)).toEqual(fixWork);
    expect(verdictModule.recordedFixWork(state, EARLIER_REVIEW_AT)).toEqual(earlierFixWork);
    expect(verdictModule.recordedFixWork(state, '2026-11-13T11:00:00.000Z')).toEqual(NO_ANSWER);
    expect(verdictModule.recordedFixWork(makeImplState([]), REVIEW_AT)).toEqual(NO_ANSWER);
  });

  it.each([
    {
      says: 'more than the red input',
      text: 'src/a.test.ts still expects the old greeting, which the plan replaced',
    },
    { says: 'less than the red input', text: 'Old greeting' },
  ])(
    'lists each red check that still blocks once, and a finding under its id never again when it says $says',
    ({ text }) => {
      const { review, state } = judged([
        blocker('V1.1', text),
        blocker('F1', 'The greeting drops an empty name'),
      ]);

      expect(verdictModule.acceptedOpen).toBeTypeOf('function');
      expect(verdictModule.acceptedOpen(review, state)).toStrictEqual({
        findings: ['The greeting drops an empty name'],
        redChecks: [
          { id: 'V1', command: 'npm test', lastLine: 'Error: 2 specs failed' },
          { id: 'K004', lastLine: 'src/a.ts(3,1): TS2322' },
        ],
      });
    },
  );

  it('names a pending red input that carries no check id by its own id', () => {
    const { review, state } = judged([], [check('P2')]);

    expect(verdictModule.acceptedOpen).toBeTypeOf('function');
    expect(verdictModule.acceptedOpen(review, state)).toStrictEqual({
      findings: [],
      redChecks: [{ id: 'P2' }],
    });
  });

  it('leaves no red check open when no red input is pending, and then lists every blocker', () => {
    const { review, state } = judged([
      blocker('V1.1', 'src/a.test.ts still expects the old greeting, which the plan replaced'),
    ]);

    expect(verdictModule.acceptedOpen).toBeTypeOf('function');
    expect(
      verdictModule.acceptedOpen(review, { ...state, pendingTriage: undefined }),
    ).toStrictEqual({
      findings: ['src/a.test.ts still expects the old greeting, which the plan replaced'],
      redChecks: [],
    });
  });

  it.each([
    {
      output: 'that ends in line breaks',
      text: 'RUN v4\nError: 2 specs failed\n\n',
      lastLine: 'Error: 2 specs failed',
    },
    {
      output: 'that ends in a line of spaces',
      text: 'FAIL src/a.test.ts\r\n   \r\n',
      lastLine: 'FAIL src/a.test.ts',
    },
    {
      output: 'that ends in a line of colour codes',
      text: '\u001b[31mError: 2 specs failed\u001b[39m\n\u001b[0m\n',
      lastLine: 'Error: 2 specs failed',
    },
    { output: 'of 300 characters', text: 'x'.repeat(300), lastLine: 'x'.repeat(300) },
    {
      output: 'longer than 300 characters',
      text: `ok\n${'x'.repeat(400)}`,
      lastLine: `${'x'.repeat(299)}…`,
    },
  ])('keeps the last line that shows text of an output $output', ({ text, lastLine }) => {
    const { review, state } = judged(
      [],
      [check('V1.1', { checkIds: ['V1'], command: 'npm test', output: text })],
    );

    expect(verdictModule.acceptedOpen).toBeTypeOf('function');
    expect(verdictModule.acceptedOpen(review, state).redChecks).toStrictEqual([
      { id: 'V1', command: 'npm test', lastLine },
    ]);
  });

  it.each([
    { output: 'that is empty', extra: { output: '' } },
    { output: 'that holds only line breaks and spaces', extra: { output: ' \n\n' } },
    { output: 'that the input does not carry', extra: {} },
  ])('keeps no last line of an output $output', ({ extra }) => {
    const { review, state } = judged(
      [],
      [check('V1.1', { checkIds: ['V1'], command: 'npm test', ...extra })],
    );

    expect(verdictModule.acceptedOpen).toBeTypeOf('function');
    expect(verdictModule.acceptedOpen(review, state).redChecks).toStrictEqual([
      { id: 'V1', command: 'npm test' },
    ]);
  });

  it('turns red inputs into one red check per check, in the order of the inputs, as an accept records them', () => {
    const red = blockingRedInputs(inputs, fixWork);
    const { review, state } = judged([]);

    expect(red.map((input) => input.id)).toEqual(['V1.1', 'V1.2', 'P1']);
    expect(verdictModule.redChecksOf).toBeTypeOf('function');
    expect(verdictModule.redChecksOf(red)).toStrictEqual([
      { id: 'V1', command: 'npm test', lastLine: 'Error: 2 specs failed' },
      { id: 'K004', lastLine: 'src/a.ts(3,1): TS2322' },
    ]);
    expect(verdictModule.acceptedOpen(review, state).redChecks).toStrictEqual(
      verdictModule.redChecksOf(red),
    );
  });

  it.each([
    {
      part: 'no command',
      extra: { output: 'RUN v4\nError: 2 specs failed\n' },
      redCheck: { id: 'V1', lastLine: 'Error: 2 specs failed' },
    },
    {
      part: 'an empty output',
      extra: { command: 'npm test', output: '' },
      redCheck: { id: 'V1', command: 'npm test' },
    },
    {
      part: 'an output that ends in lines with no text',
      extra: { command: 'npm test', output: 'FAIL src/a.test.ts\n\u001b[0m\n   \n' },
      redCheck: { id: 'V1', command: 'npm test', lastLine: 'FAIL src/a.test.ts' },
    },
  ])(
    'gives the red check of an input with $part only the parts it holds',
    ({ extra, redCheck }) => {
      expect(verdictModule.redChecksOf).toBeTypeOf('function');
      expect(
        verdictModule.redChecksOf([check('V1.1', { checkIds: ['V1'], ...extra })]),
      ).toStrictEqual([redCheck]);
    },
  );

  it('names the red check of an input with no check id by the input id, and gives none for no input', () => {
    expect(verdictModule.redChecksOf).toBeTypeOf('function');
    expect(verdictModule.redChecksOf([check('P2')])).toStrictEqual([{ id: 'P2' }]);
    expect(verdictModule.redChecksOf([])).toStrictEqual([]);
  });

  it('counts no red input among the open findings: an accept names it as a red check', () => {
    const outcome = deriveReviewOutcome(
      makeVerdict({
        criteria: [criterion('C1', 'unverified')],
        findings: [blocker('F1', 'The greeting drops an empty name')],
      }),
      scope,
      verification(),
      [check('V1.1'), check('P1')],
    );

    expect(outcome.redInputs.map((input) => input.id)).toEqual(['V1.1', 'P1']);
    expect(openFindings(outcome)).toEqual([
      'The greeting drops an empty name',
      'Criterion C1: unverified — Checked against the implementation diff',
    ]);
  });

  it('spells a red check on one line, without the part it lacks', () => {
    expect(verdictModule.redCheckLine).toBeTypeOf('function');
    expect(
      verdictModule.redCheckLine({
        id: 'V1',
        command: 'npm test',
        lastLine: 'Error: 2 specs failed',
      }),
    ).toBe('V1 failed · npm test · Error: 2 specs failed');
    expect(verdictModule.redCheckLine({ id: 'K004', lastLine: 'src/a.ts(3,1): TS2322' })).toBe(
      'K004 failed · src/a.ts(3,1): TS2322',
    );
    expect(verdictModule.redCheckLine({ id: 'V1', command: 'npm test' })).toBe(
      'V1 failed · npm test',
    );
    expect(verdictModule.redCheckLine({ id: 'P2' })).toBe('P2 failed');
  });

  const v1 = { id: 'V1', command: 'npm test', lastLine: 'Error: 2 specs failed' };
  const k004 = { id: 'K004', lastLine: 'src/a.ts(3,1): TS2322' };

  it.each([
    {
      form: 'a red check and open findings',
      accepted: { redChecks: [v1], findings: ['a', 'b'] },
      counts: {
        phrase: '1 red check and 2 open findings',
        fact: '1 red check · 2 open findings',
        redChecks: '1 red check',
        redCheckIds: '1 red check: V1 · npm test',
      },
    },
    {
      form: 'two red checks and one open finding',
      accepted: { redChecks: [v1, k004], findings: ['a'] },
      counts: {
        phrase: '2 red checks and 1 open finding',
        fact: '2 red checks · 1 open finding',
        redChecks: '2 red checks',
        redCheckIds: '2 red checks: V1 · npm test, K004 · src/a.ts(3,1): TS2322',
      },
    },
    {
      form: 'a red check and no open finding',
      accepted: { redChecks: [v1], findings: [] },
      counts: {
        phrase: '1 red check',
        fact: '1 red check',
        redChecks: '1 red check',
        redCheckIds: '1 red check: V1 · npm test',
      },
    },
    {
      form: 'a red check and no list of findings',
      accepted: { redChecks: [v1] },
      counts: {
        phrase: '1 red check',
        fact: '1 red check',
        redChecks: '1 red check',
        redCheckIds: '1 red check: V1 · npm test',
      },
    },
    {
      form: 'an empty list of red checks',
      accepted: { redChecks: [], findings: ['a', 'b'] },
      counts: {
        phrase: '2 open findings',
        fact: '2 open findings',
        redChecks: undefined,
        redCheckIds: undefined,
      },
    },
  ])('spells the counts of an accept with $form', ({ accepted, counts }) => {
    expect(verdictModule.acceptedCounts).toBeTypeOf('function');
    expect(verdictModule.acceptedCounts(accepted)).toStrictEqual(counts);
  });

  it.each([0, 1, 2, 7])(
    'counts an accept with no red check and %i open findings in the words of today',
    (count) => {
      const findings = Array.from({ length: count }, (_, index) => `finding ${index + 1}`);

      expect(verdictModule.acceptedCounts).toBeTypeOf('function');
      expect(verdictModule.acceptedCounts({ findings })).toStrictEqual({
        phrase: countNoun(count, 'open finding'),
        fact: countNoun(count, 'open finding'),
        redChecks: undefined,
        redCheckIds: undefined,
      });
    },
  );

  it.each([
    {
      form: 'no red check',
      accepted: { findings: ['Missing test', 'The error is not logged'] },
      sentence: 'Run accepted as is with 2 open findings: Missing test; The error is not logged.',
    },
    {
      form: 'a red check and an open finding',
      accepted: { redChecks: [v1], findings: ['a'] },
      sentence:
        'Run accepted as is with 1 red check and 1 open finding: V1 failed · npm test · Error: 2 specs failed; a.',
    },
    {
      form: 'a red check and no open finding',
      accepted: { redChecks: [v1], findings: [] },
      sentence:
        'Run accepted as is with 1 red check: V1 failed · npm test · Error: 2 specs failed.',
    },
    {
      form: 'your note',
      accepted: { findings: ['Review input is 9 characters'], note: 'Checked by hand' },
      sentence:
        'Run accepted as is with 1 open finding: Review input is 9 characters. Your note: Checked by hand.',
    },
    {
      form: "the planner's note",
      accepted: {
        findings: ['Keep the old error'],
        note: 'The error type is public API',
        by: 'planner' as const,
      },
      sentence:
        "Run accepted as is with 1 open finding: Keep the old error. Planner's note: The error type is public API.",
    },
    {
      form: 'findings and a note that end with a full stop',
      accepted: {
        findings: ['Missing test.', 'The error is not logged.'],
        note: 'Checked by hand.',
      },
      sentence:
        'Run accepted as is with 2 open findings: Missing test; The error is not logged. Your note: Checked by hand.',
    },
    {
      form: 'a finding and a note that end with a question mark',
      accepted: { findings: ['Is the cap right?'], note: 'Why review this?' },
      sentence:
        'Run accepted as is with 1 open finding: Is the cap right? Your note: Why review this?',
    },
    {
      form: 'red checks, a finding and a note of more than one line',
      accepted: {
        redChecks: [
          { id: 'K004', lastLine: 'src/a.ts(3,1): TS2322.' },
          { id: 'V1', command: 'npm run lint &&\n  npm test' },
        ],
        findings: ['Edge case missing\nUnicode input is not covered'],
        note: 'Checked\nby hand',
      },
      sentence:
        'Run accepted as is with 2 red checks and 1 open finding: K004 failed · src/a.ts(3,1): TS2322; V1 failed · npm run lint && npm test; Edge case missing Unicode input is not covered. Your note: Checked by hand.',
    },
  ])('says an accept with $form in one sentence', ({ accepted, sentence }) => {
    expect(verdictModule.acceptedSentence).toBeTypeOf('function');
    expect(verdictModule.acceptedSentence({ at: '2026-09-01T00:00:00.000Z', ...accepted })).toBe(
      sentence,
    );
  });
});
