import { describe, expect, it } from 'vitest';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { getSummaryDetailViewportHeight } from './detail-layout.js';

describe('getSummaryDetailViewportHeight', () => {
  it('budgets one fewer row when small and the reviewer row renders', () => {
    const base = {
      terminalRows: 24,
      isSmall: true,
      summary: makeSummary({ plannerTool: 'claude-code' }),
      implementerSummary: 'Ollama',
      reviewerSummary: PLANNER_INHERITANCE.sentence,
      routeSummary: 'Claude Code CLI',
    };
    const withReviewer = getSummaryDetailViewportHeight(base);
    const withoutReviewer = getSummaryDetailViewportHeight({ ...base, reviewerSummary: null });
    expect(withoutReviewer - withReviewer).toBe(1);
  });

  it('charges the reviewer row its gap too when not small', () => {
    const base = {
      terminalRows: 40,
      isSmall: false,
      summary: makeSummary({ plannerTool: 'claude-code' }),
      implementerSummary: 'Ollama',
      reviewerSummary: PLANNER_INHERITANCE.sentence,
      routeSummary: 'Claude Code CLI',
    };
    const withReviewer = getSummaryDetailViewportHeight(base);
    const withoutReviewer = getSummaryDetailViewportHeight({ ...base, reviewerSummary: null });
    expect(withoutReviewer - withReviewer).toBe(2);
  });

  it('never drops below the one-row floor', () => {
    const height = getSummaryDetailViewportHeight({
      terminalRows: 8,
      isSmall: true,
      summary: makeSummary({
        plannerTool: 'claude-code',
        briefQuality: { score: 0.9, passed: true, errorCount: 0, warningCount: 0 },
        driftSummary: { score: 0.9, passed: true, errorCount: 0, warningCount: 0 },
      }),
      implementerSummary: 'Ollama',
      reviewerSummary: PLANNER_INHERITANCE.sentence,
      routeSummary: 'Claude Code CLI',
    });
    expect(height).toBe(1);
  });
});
