import { describe, it, expect, vi } from 'vitest';
import { renderFeature } from '../../../../testing/helpers/ink.js';
import { CostApprovalPrompt } from './cost-approval-prompt.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';

function makePrediction(): CostPrediction {
  return {
    estimatedTasks: 12, lowCost: 0.08, expectedCost: 0.14, highCost: 0.35,
    plannerTool: 'anthropic', implementerTool: 'anthropic',
    deterministic: {
      taskCount: 12,
      taskFitCounts: { fits: 10, tight: 1, overflow: 0, unknown: 1 },
      contextConfidenceCounts: { contextExplicit: 5, contextKnownCatalog: 4, contextCachedProvider: 2, contextConservativeFallback: 1, profileUnavailable: 0 },
      priceConfidenceCounts: { priceKnown: 12, priceUnknown: 0, profileUnavailable: 0 },
      tasks: [],
      totals: { knownActualEstimate: 0.14, hypotheticalAllPlanner: 1.20, estimatedSavings: 1.06, unknownCostReason: [] },
    },
  };
}

describe('CostApprovalPrompt', () => {
  it('renders task count and cost estimate', () => {
    const ui = renderFeature(
      <CostApprovalPrompt prediction={makePrediction()} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    const output = ui.lastFrame() ?? '';
    expect(output).toContain('12 tasks');
    expect(output).toContain('$0.14');
    expect(output).toContain('~$1.20');
    expect(output).toContain('Approve?');
    ui.unmount();
  });

  it('calls onApprove when y is pressed', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt prediction={makePrediction()} onApprove={onApprove} onReject={onReject} />,
    );
    ui.stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('calls onReject when n is pressed', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt prediction={makePrediction()} onApprove={onApprove} onReject={onReject} />,
    );
    ui.stdin.write('n');
    expect(onReject).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    ui.unmount();
  });

});
