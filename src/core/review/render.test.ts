import { describe, expect, it } from 'vitest';
import type { ReviewVerdict } from '../schemas/review.js';
import { taskId } from '../schemas/task.js';
import { renderReviewMarkdown } from './render.js';
import { deriveReviewOutcome, reviewFindingCounts, type ReviewScope } from './verdict.js';

type Finding = ReviewVerdict['findings'][number];

const scope: ReviewScope = { kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] };

function verdictWord(markdown: string): string {
  return markdown.match(/### Verdict\n\n(\S+)/)?.[1] ?? '';
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F1',
    kind: 'defect',
    severity: 'minor',
    taskId: null,
    file: null,
    line: null,
    text: 'The greeting drops an empty name',
    acceptance: null,
    checkIds: null,
    criterionId: null,
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    tasks: [{ id: taskId('T001'), plan: 'met', note: 'The module exists' }],
    criteria: [{ id: 'C1', status: 'pass', evidence: 'src/hello.test.ts passes' }],
    findings: [],
    ...overrides,
  };
}

describe('renderReviewMarkdown', () => {
  it('renders findings outside the task review scope as notes and counts them', () => {
    const verdict = makeVerdict({
      findings: [
        makeFinding({ id: 'F1', severity: 'blocking', text: 'C10/C11 not implemented' }),
        makeFinding({ id: 'F2', taskId: 'T001', text: 'The greeting test misses a case' }),
      ],
    });
    const outcome = deriveReviewOutcome(verdict, { ...scope, kind: 'task' }, new Map());
    const markdown = renderReviewMarkdown(verdict, outcome, []);
    expect(markdown).toContain(
      '**Note**\n\n- The greeting test misses a case\n- Outside the task review scope: C10/C11 not implemented',
    );
    expect(reviewFindingCounts(outcome)).toEqual({ critical: 0, warning: 1, note: 1 });
    const onlyOutside = { ...verdict, findings: verdict.findings.slice(0, 1) };
    const onlyNotes = renderReviewMarkdown(
      onlyOutside,
      deriveReviewOutcome(onlyOutside, { ...scope, kind: 'task' }, new Map()),
      [],
    );
    expect(onlyNotes).toContain(
      '**Note**\n\n- Outside the task review scope: C10/C11 not implemented',
    );
  });

  it('renders a successfully verified criterion with its effective status', () => {
    const verdict = makeVerdict({ criteria: [{ id: 'C1', status: 'unverified', evidence: 'K1' }] });
    const outcome = deriveReviewOutcome(verdict, scope, new Map([['criterion:C1', 'pass']]));
    expect(renderReviewMarkdown(verdict, outcome, [])).toContain('**[PASS]** C1');
    expect(verdict.criteria[0]?.status).toBe('unverified');
  });
  it('puts the derived verdict word under the Verdict heading', () => {
    const passing = makeVerdict();
    const passed = deriveReviewOutcome(passing, scope, new Map());
    expect(verdictWord(renderReviewMarkdown(passing, passed, []))).toBe('pass');

    const noted = makeVerdict({ findings: [makeFinding()] });
    const withNotes = deriveReviewOutcome(noted, scope, new Map());
    expect(verdictWord(renderReviewMarkdown(noted, withNotes, []))).toBe('pass_with_notes');

    const failed = makeVerdict({
      criteria: [{ id: 'C1', status: 'fail', evidence: 'The greeting throws' }],
      findings: [makeFinding({ severity: 'blocking', criterionId: 'C1' })],
    });
    const failing = deriveReviewOutcome(failed, scope, new Map());
    expect(verdictWord(renderReviewMarkdown(failed, failing, []))).toBe('fail');
  });

  it('lists each red input that still blocks under Critical with the first line of its text', () => {
    const verdict = makeVerdict();
    const outcome = deriveReviewOutcome(verdict, scope, new Map(), [
      { id: 'A1', text: 'Apply wrote conflict markers into src/a.ts\n<<<<<<< ours' },
    ]);
    const markdown = renderReviewMarkdown(verdict, outcome, []);
    expect(verdictWord(markdown)).toBe('fail');
    expect(markdown).toContain(
      '**Critical**\n\n- A1: Apply wrote conflict markers into src/a.ts\n\n**Note**',
    );
  });

  it('renders the tasks, the criteria marks and the findings under their labels', () => {
    const verdict = makeVerdict({
      criteria: [
        { id: 'C1', status: 'pass', evidence: 'src/hello.test.ts passes' },
        { id: 'C2', status: 'unverified', evidence: '' },
      ],
      findings: [makeFinding({ id: 'F2', text: 'The empty-name test misses a case' })],
    });
    const outcome = deriveReviewOutcome(
      verdict,
      { kind: 'final', taskIds: ['T001'], criterionIds: ['C1', 'C2'] },
      new Map(),
    );
    const markdown = renderReviewMarkdown(verdict, outcome, []);
    expect(markdown).toContain('### Tasks');
    expect(markdown).toContain('- [met] T001');
    expect(markdown).toContain('### Criteria Results');
    expect(markdown).toContain('**[PASS]**');
    expect(markdown).toContain('**[UNVERIFIED]**');
    expect(markdown).toContain('### Findings');
    expect(markdown).toContain('**Critical**');
    expect(markdown).toContain('**Note**');
    expect(markdown).toContain('The empty-name test misses a case');
    expect(markdown).not.toContain('### Pre-existing failures');
  });

  it('names each reviewer check red at the run base too, with its first failures', () => {
    const verdict = makeVerdict();
    const outcome = deriveReviewOutcome(verdict, scope, new Map());
    const markdown = renderReviewMarkdown(verdict, outcome, [
      {
        id: 'V1',
        command: 'node --test legacy/report-suite.mjs',
        keys: ['legacy/report-suite.mjs::legacy report > total matches the ledger'],
      },
      { id: 'V2', command: 'npm test', keys: ['a::1', 'a::2', 'a::3', 'a::4', 'a::5'] },
    ]);

    expect(verdictWord(markdown)).toBe('pass');
    expect(markdown).toContain(
      [
        '### Pre-existing failures',
        '',
        "These reviewer checks failed at the run base too. Their failures below also fail before this run's changes, so they raise no finding.",
        '',
        '- V1 `node --test legacy/report-suite.mjs`',
        '  - legacy/report-suite.mjs::legacy report > total matches the ledger',
        '- V2 `npm test`',
        '  - a::1',
        '  - a::2',
        '  - a::3',
        '  - +2\u00a0more',
      ].join('\n'),
    );
  });
});
