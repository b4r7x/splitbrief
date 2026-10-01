import { describe, expect, it } from 'vitest';
import { plannerStepsFor } from '../../../core/pipeline-spec/steps.js';
import {
  CONFIRM_HINT,
  CONFIRM_NUDGE,
  CONFIRM_REASON_HINTS,
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
  STICKY_HINTS,
  approvalKeyColumnWidth,
  getConfirmOptions,
  getConfirmPrimaryKey,
  getReviewDocumentPromptRows,
  reviewArtifactForPhase,
  reviewDocumentOptions,
} from './approval.js';

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
    expect(STICKY_HINTS).toBe('↑↓ select · ⏎ confirm · esc deny');
  });

  it('keeps the way out on the refusal a stray y earns', () => {
    expect(CONFIRM_NUDGE).toBe('⏎ confirms this write · esc deny');
  });
});

describe('reviewArtifactForPhase', () => {
  it.each([
    ['reviewing-spec', 'spec'],
    ['reviewing-plan', 'plan'],
    ['reviewing-briefs', 'briefs'],
  ] as const)('maps %s to the artifact under review', (phase, artifact) => {
    expect(reviewArtifactForPhase(phase)).toBe(artifact);
  });

  it('leaves every other phase without a review panel', () => {
    expect(reviewArtifactForPhase('implementing')).toBeNull();
  });
});

describe('reviewDocumentOptions', () => {
  it('gives every row a distinct key and the command it dispatches', () => {
    const rows = reviewDocumentOptions('plan');

    expect(rows.map((row) => row.key)).toEqual(['y', 'c', 'e', 'q']);
    expect(rows.map((row) => row.command)).toEqual(['approve', 'comment', 'edit-file', 'end-run']);
  });

  it('names what ending the run does instead of calling it a rejection', () => {
    const labels = reviewDocumentOptions('briefs').map((row) => row.label);

    expect(labels).toContain('End run (close this run)');
    expect(labels.join(' ')).not.toMatch(/reject/i);
  });

  it.each(['spec', 'plan', 'briefs'] as const)(
    'claims no kept changes at the %s gate, which opens before any brief has run',
    (artifact) => {
      const labels = reviewDocumentOptions(artifact).map((row) => row.label);

      expect(labels).toContain('End run (close this run)');
      expect(labels.join(' ')).not.toMatch(/keep changes/);
    },
  );

  it('releases the briefs review from the plan gate, which opens after the briefs are compiled', () => {
    for (const mode of ['standard', 'speckit'] as const) {
      const steps = plannerStepsFor(mode, 'all');
      const gate = steps.findIndex((step) => step.gateAfter === 'plan');
      expect(steps.slice(0, gate + 1).map((step) => step.call)).toContain('tasks');
    }

    expect(reviewDocumentOptions('plan')[0]?.label).toBe('Approve plan and review the briefs');
  });
});

describe('getReviewDocumentPromptRows', () => {
  it('budgets nothing when no artifact is on review', () => {
    expect(getReviewDocumentPromptRows(null, 120)).toBe(0);
  });

  it('budgets the four rows, the blank and the legend inside the border', () => {
    expect(getReviewDocumentPromptRows('plan', 120)).toBe(2 + 4 + 1 + 1);
  });

  it('keeps the legend on one row at the narrowest supported width', () => {
    expect(getReviewDocumentPromptRows('briefs', 60)).toBeLessThanOrEqual(
      2 + 4 + 1 + REVIEW_DOCUMENT_HINTS.length,
    );
  });
});
