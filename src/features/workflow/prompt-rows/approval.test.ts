import { describe, expect, it } from 'vitest';
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

    expect(labels).toContain('End run (close this run; keep changes)');
    expect(labels.join(' ')).not.toMatch(/reject/i);
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
