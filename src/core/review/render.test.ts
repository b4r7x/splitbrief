import { describe, expect, it } from 'vitest';
import type { ReviewVerdict } from '../schemas/review.js';
import { taskId } from '../schemas/task.js';
import { renderReviewMarkdown } from './render.js';
import { deriveReviewOutcome } from './verdict.js';

type Finding = ReviewVerdict['findings'][number];

const scope = { taskIds: ['T001'], criterionIds: ['C1'] };

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
  it('renders a successfully verified criterion with its effective status', () => {
    const verdict = makeVerdict({ criteria: [{ id: 'C1', status: 'unverified', evidence: 'K1' }] });
    const outcome = deriveReviewOutcome(verdict, scope, new Map([['criterion:C1', 'pass']]));
    expect(renderReviewMarkdown(verdict, outcome)).toContain('**[PASS]** C1');
    expect(verdict.criteria[0]?.status).toBe('unverified');
  });
  it('puts the derived verdict word under the Verdict heading', () => {
    const passing = makeVerdict();
    const passed = deriveReviewOutcome(passing, scope, new Map());
    expect(verdictWord(renderReviewMarkdown(passing, passed))).toBe('pass');

    const noted = makeVerdict({ findings: [makeFinding()] });
    const withNotes = deriveReviewOutcome(noted, scope, new Map());
    expect(verdictWord(renderReviewMarkdown(noted, withNotes))).toBe('pass_with_notes');

    const failed = makeVerdict({
      criteria: [{ id: 'C1', status: 'fail', evidence: 'The greeting throws' }],
      findings: [makeFinding({ severity: 'blocking', criterionId: 'C1' })],
    });
    const failing = deriveReviewOutcome(failed, scope, new Map());
    expect(verdictWord(renderReviewMarkdown(failed, failing))).toBe('fail');
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
      { taskIds: ['T001'], criterionIds: ['C1', 'C2'] },
      new Map(),
    );
    const markdown = renderReviewMarkdown(verdict, outcome);
    expect(markdown).toContain('### Tasks');
    expect(markdown).toContain('- [met] T001');
    expect(markdown).toContain('### Criteria Results');
    expect(markdown).toContain('**[PASS]**');
    expect(markdown).toContain('**[UNVERIFIED]**');
    expect(markdown).toContain('### Findings');
    expect(markdown).toContain('**Critical**');
    expect(markdown).toContain('**Note**');
    expect(markdown).toContain('The empty-name test misses a case');
  });
});
