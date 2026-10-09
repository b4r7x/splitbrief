import { describe, expect, it } from 'vitest';
import {
  CONFIRM_HINT,
  CONFIRM_NUDGE,
  CONFIRM_REASON_HINTS,
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
  CHOOSE_HINTS,
  approvalKeyColumnWidth,
  getConfirmOptions,
  getConfirmPrimaryKey,
  getReviewDocumentPromptRows,
  reviewArtifactForPhase,
  reviewDocumentForm,
  reviewDocumentOptions,
} from './approval.js';
import { REVIEW_DECORATION_ROWS } from '../layout/rect.js';

describe('review gate legends', () => {
  it('keeps the document legend to the keys its option rows do not spell out', () => {
    expect(REVIEW_DOCUMENT_HINTS).toBe('↑↓ select · ⏎ confirm');
  });

  it('names only the keys live while a comment is being typed', () => {
    expect(REVIEW_COMMENT_HINTS).toBe('⏎ send · esc back');
  });
});

describe('confirm gate keys and legends', () => {
  it('takes y on every confirm-tier class except the irreversible one', () => {
    expect(getConfirmPrimaryKey('package_change')).toBe('y');
    expect(getConfirmPrimaryKey('write_out_of_scope')).toBe('y');
    expect(getConfirmPrimaryKey('sensitive_change')).toBe('y');
    expect(getConfirmPrimaryKey('destructive')).toBe('');
  });

  it('leaves the Confirm row without a key on a destructive gate, so r sets the column', () => {
    expect(getConfirmOptions('destructive').map((option) => option.key)).toEqual(['', 'r', 'x']);
    expect(approvalKeyColumnWidth(getConfirmOptions('destructive'))).toBe(1);
    expect(getConfirmOptions('package_change').map((option) => option.key)).toEqual([
      'y',
      'r',
      'x',
    ]);
  });

  it('teaches ⏎ as confirm and esc as deny on both steps', () => {
    expect(CONFIRM_HINT).toEqual({ key: '⏎', verb: 'confirm' });
    expect(CONFIRM_REASON_HINTS).toBe('⏎ confirm · esc deny');
    expect(CHOOSE_HINTS).toBe('↑↓ select · ⏎ confirm · esc deny');
  });

  it('keeps the way out on the refusal a stray y earns', () => {
    expect(CONFIRM_NUDGE).toBe('⏎ confirms this write · esc deny');
  });
});

describe('reviewArtifactForPhase', () => {
  it('maps reviewing-plan to the plan card', () => {
    expect(reviewArtifactForPhase('reviewing-plan')).toBe('plan');
  });

  it.each(['implementing', 'reviewing-spec', 'reviewing-briefs'] as const)(
    'leaves %s without a review panel',
    (phase) => {
      expect(reviewArtifactForPhase(phase)).toBeNull();
    },
  );
});

describe('reviewDocumentOptions', () => {
  it('gives every row the command it dispatches', () => {
    const rows = reviewDocumentOptions('plan');

    expect(rows.map((row) => row.command)).toEqual(['approve', 'comment', 'edit-file', 'end-run']);
  });

  it('names what ending the run does instead of calling it a rejection', () => {
    const labels = reviewDocumentOptions('plan').map((row) => row.label);

    expect(labels).toContain('End run (close this run)');
    expect(labels.join(' ')).not.toMatch(/reject/i);
  });

  it('claims no kept changes at the plan card, which opens before any brief has run', () => {
    const labels = reviewDocumentOptions('plan').map((row) => row.label);

    expect(labels).toContain('End run (close this run)');
    expect(labels.join(' ')).not.toMatch(/keep changes/);
  });

  it('releases the build from the plan card', () => {
    expect(reviewDocumentOptions('plan')[0]?.label).toBe('Approve plan and start the build');
  });

  it('edits plan.json at the plan card, the file plan.md is rendered from', () => {
    expect(reviewDocumentOptions('plan')[2]?.label).toBe('Edit plan.json');
  });
});

describe('getReviewDocumentPromptRows', () => {
  const TALL = 40;

  it('budgets nothing when no artifact is on review', () => {
    expect(getReviewDocumentPromptRows(null, [], 120, TALL)).toBe(0);
  });

  it('budgets one more row for what approving confirms', () => {
    expect(getReviewDocumentPromptRows('plan', ['write package.json'], 120, TALL)).toBe(
      2 + 1 + 4 + 1 + 1,
    );
  });

  it('budgets the four rows, the blank and the legend inside the border', () => {
    expect(getReviewDocumentPromptRows('plan', [], 120, TALL)).toBe(2 + 4 + 1 + 1);
  });

  it('draws no border below 80 columns, however tall the terminal', () => {
    expect(getReviewDocumentPromptRows('plan', [], 60, TALL)).toBe(4 + 1);
  });

  it('keeps the legend on one row at the narrowest supported width', () => {
    expect(getReviewDocumentPromptRows('plan', [], 60, TALL)).toBeLessThanOrEqual(
      2 + 4 + 1 + REVIEW_DOCUMENT_HINTS.length,
    );
  });
});

describe('reviewDocumentForm', () => {
  const confirms = ['write package.json'];

  it('sheds the border on a wide but short terminal before the plan loses its rows', () => {
    const budgetRows = 6 + REVIEW_DECORATION_ROWS;
    expect(reviewDocumentForm({ artifact: 'plan', confirms, cols: 120, budgetRows })).toEqual({
      framed: false,
      legend: true,
      confirmsText: 'Approving also confirms: write package.json',
    });
  });

  it('sheds the legend next, then counts what approving confirms', () => {
    expect(
      reviewDocumentForm({
        artifact: 'plan',
        confirms,
        cols: 120,
        budgetRows: 5 + REVIEW_DECORATION_ROWS,
      }).legend,
    ).toBe(false);
    expect(
      reviewDocumentForm({
        artifact: 'plan',
        confirms: ['write package.json', 'write .github/workflows/ci.yml'],
        cols: 60,
        budgetRows: 5,
      }).confirmsText,
    ).toBe('Approving also confirms 2 protected operations');
  });

  it('starts every wrapped line of a long confirms list at its column', () => {
    const many = [
      'write package.json',
      'write package-lock.json',
      'write .github/workflows/release-and-publish-npm.yml',
      'write packages/cli/package.json',
      'write packages/core/package.json',
      'write .env.example',
    ];
    for (let cols = 60; cols <= 120; cols++) {
      const { confirmsText } = reviewDocumentForm({
        artifact: 'plan',
        confirms: many,
        cols,
        budgetRows: Number.POSITIVE_INFINITY,
      });
      const lines = confirmsText?.split('\n') ?? [];
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(line, `at ${cols} columns`).not.toMatch(/^\s/);
    }
  });

  // UI debt #56: at 120 columns the S11 plan card read `…, npm run` / `check:invariants`.
  it('breaks a confirms list between operations, never inside one', () => {
    const operations = [
      'write package.json',
      'write package-lock.json',
      'npm run typecheck',
      'npm run check:invariants',
      'npm run skills:check',
    ];
    for (let cols = 60; cols <= 160; cols++) {
      const { confirmsText } = reviewDocumentForm({
        artifact: 'plan',
        confirms: operations,
        cols,
        budgetRows: Number.POSITIVE_INFINITY,
      });
      const lines = confirmsText?.split('\n') ?? [];
      for (const operation of operations) {
        expect(
          lines.some((line) => line.includes(operation)),
          `${operation} at ${cols} columns`,
        ).toBe(true);
      }
      for (const line of lines.slice(0, -1)) {
        expect(line, `at ${cols} columns`).toMatch(/,$/);
      }
    }
  });

  it('moves the first command intact below the introduction at 60 columns', () => {
    expect(
      reviewDocumentForm({
        artifact: 'plan',
        confirms: ['npm run check:invariants -- --strict', 'npm run typecheck'],
        cols: 60,
        budgetRows: Number.POSITIVE_INFINITY,
      }).confirmsText,
    ).toBe('Approving also confirms:\nnpm run check:invariants -- --strict,\nnpm run typecheck');
  });

  it('counts operations at 60 columns when the separating comma exceeds the line width', () => {
    const operations = [
      'npm run check:invariants -- --strict --reporter=dots',
      'npm run typecheck',
    ];
    expect(
      reviewDocumentForm({
        artifact: 'plan',
        confirms: operations,
        cols: 60,
        budgetRows: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      framed: false,
      legend: true,
      confirmsText: 'Approving also confirms 2 protected operations',
    });
    expect(getReviewDocumentPromptRows('plan', operations, 60, Number.POSITIVE_INFINITY)).toBe(
      1 + 4 + 1,
    );
  });

  it('counts operations at 60 columns when a command cannot fit on one line', () => {
    const operations = [
      'npm run typecheck',
      'npm run test:integration -- --project workflow-screen --reporter verbose',
    ];
    expect(
      reviewDocumentForm({
        artifact: 'plan',
        confirms: operations,
        cols: 60,
        budgetRows: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      framed: false,
      legend: true,
      confirmsText: 'Approving also confirms 2 protected operations',
    });
    expect(getReviewDocumentPromptRows('plan', operations, 60, Number.POSITIVE_INFINITY)).toBe(
      1 + 4 + 1,
    );
  });

  it('keeps every option when even the fewest rows do not fit', () => {
    const form = reviewDocumentForm({ artifact: 'plan', confirms, cols: 60, budgetRows: 0 });

    expect(form).toEqual({
      framed: false,
      legend: false,
      confirmsText: 'Approving also confirms 1 protected operation',
    });
    expect(getReviewDocumentPromptRows('plan', confirms, 60, 0)).toBe(1 + 4);
  });
});
