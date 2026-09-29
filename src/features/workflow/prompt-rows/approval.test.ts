import { describe, expect, it } from 'vitest';
import { plannerStepsFor } from '../../../core/pipeline-spec/steps.js';
import {
  REVIEW_DOCUMENT_HINTS,
  getReviewDocumentPromptRows,
  reviewArtifactForPhase,
  reviewDocumentOptions,
} from './approval.js';

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
