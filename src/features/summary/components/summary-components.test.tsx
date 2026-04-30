import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import { makeSummary } from '../../../../testing/helpers/factories/summary.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { SummaryCostBreakdown } from './summary-cost-breakdown.js';
import { SummaryProgress } from './summary-progress.js';
import { SummaryCheckpoints } from './summary-checkpoints.js';
import { SummaryReviewPacket } from './summary-review-packet.js';

afterEach(() => {
  terminalSizeStore.__testReset();
});

describe('SummaryProgress', () => {
  it('renders local, escalated, and failed counts with the completion ratio', () => {
    const ui = renderFeature(
      <SummaryProgress
        completed={2}
        total={4}
        completedByLocal={1}
        escalatedToPlanner={1}
        failed={1}
        isSmall={false}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('2/4');
    expect(frame).toContain('1 local');
    expect(frame).toContain('1 escalated');
    expect(frame).toContain('1 failed');
    expect(frame).toContain('local = cheap implementer');

    ui.unmount();
  });
});

describe('SummaryCostBreakdown', () => {
  it('renders actual cost, savings, local rate, and provider costs', () => {
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 5,
      actualPlannerCost: 1,
      actualImplementerCost: 0.5,
      totalActualCost: 1.5,
      savingsAmount: 4.5,
      savingsPercentage: 75,
      localCompletionRate: 0.75,
      hasPricedUsage: true,
      hasSavingsEstimate: true,
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: true,
      isTotalActualCostKnown: true,
      isAllPlannerBaselineKnown: true,
      providerCosts: {
        anthropic: { inputTokens: 100_000, outputTokens: 50_000, cost: 1 },
        deepseek: { inputTokens: 200_000, outputTokens: 100_000, cost: 0.5 },
      },
    };

    const ui = renderFeature(
      <SummaryCostBreakdown
        costBreakdown={costBreakdown}
        labelWidth={28}
        isSmall={false}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Actual cost');
    expect(frame).toContain('$1.50');
    expect(frame).toContain('Planner cost');
    expect(frame).toContain('Implementer cost');
    expect(frame).toContain('All-planner baseline');
    expect(frame).toContain('$5.00');
    expect(frame).toContain('Saved');
    expect(frame).toContain('$4.50 (75%)');
    expect(frame).toContain('Local/cheap rate');
    expect(frame).toContain('75%');
    expect(frame).toContain('Anthropic');
    expect(frame).toContain('DeepSeek');

    ui.unmount();
  });

  it('renders unknown price instead of fake zero cost when implementer pricing is unavailable', () => {
    const costBreakdown: CostBreakdown = {
      hypotheticalCost: 18,
      actualPlannerCost: 1,
      actualImplementerCost: 0,
      totalActualCost: 1,
      savingsAmount: 0,
      savingsPercentage: 0,
      localCompletionRate: 1,
      hasPricedUsage: true,
      hasUnpricedUsage: true,
      hasSavingsEstimate: false,
      isActualPlannerCostKnown: true,
      isActualImplementerCostKnown: false,
      isTotalActualCostKnown: false,
      isAllPlannerBaselineKnown: true,
    };

    const ui = renderFeature(
      <SummaryCostBreakdown
        costBreakdown={costBreakdown}
        labelWidth={28}
        isSmall={false}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Actual cost');
    expect(frame).toContain('$1.00 + unknown');
    expect(frame).toContain('All-planner baseline');
    expect(frame).toContain('$18.00');
    expect(frame).toContain('Saved');
    expect(frame).toContain('Unknown price');
    expect(frame).toContain('Local/cheap rate');
    expect(frame).toContain('100%');
    expect(frame).not.toContain('$0.00');

    ui.unmount();
  });
});

describe('SummaryCheckpoints', () => {
  it('renders checkpoint commands as user-facing summary output', () => {
    terminalSizeStore.__testReset({ cols: 160, isSmall: false });

    const ui = renderFeature(
      <SummaryCheckpoints
        checkpointSummary={{
          count: 1,
          latestId: 'snap-pre-final',
          latestName: 'pre-final-review',
          latestKind: 'pre-final-review',
          latestRunCheckpointId: 'snap-pre-final',
          preFinalReviewId: 'snap-pre-final',
          accepted: null,
          rejected: null,
          diffCommand: 'diptych snapshot diff snap-pre-final',
          restoreCommand: 'diptych snapshot restore snap-pre-final',
        }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Checkpoints');
    expect(frame).toContain('1 checkpoint');
    expect(frame).toContain('diptych snapshot diff snap-pre-final');
    expect(frame).toContain('diptych snapshot restore snap-pre-final');

    ui.unmount();
  });
});

describe('SummaryReviewPacket', () => {
  it('renders the packet artifact paths and checklist hint', () => {
    const ui = renderFeature(
      <SummaryReviewPacket
        summary={makeSummary({
          reviewPacket: {
            markdownPath: 'review-packet.md',
            jsonPath: 'review-packet.json',
            generatedAt: '2026-04-28T10:00:00.000Z',
            finalReviewStatus: 'written',
            driftPassed: true,
            evidenceValidatedTasks: 1,
            evidenceTotalTasks: 1,
            missingArtifactCount: 0,
          },
        })}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Review packet');
    expect(frame).toContain('review-packet.md');
    expect(frame).toContain('review-packet.json');
    expect(frame).toContain('checklist');

    ui.unmount();
  });
});
