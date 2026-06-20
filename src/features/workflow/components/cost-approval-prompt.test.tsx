import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { CostApprovalPrompt } from './cost-approval-prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../prompt-grace.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';

const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

function makePrediction(): CostPrediction {
  return {
    estimatedTasks: 12,
    lowCost: 0.08,
    expectedCost: 0.14,
    highCost: 0.35,
    plannerTool: 'anthropic',
    implementerTool: 'anthropic',
    deterministic: {
      estimateScope: 'prompt-input-only',
      taskCount: 12,
      taskFitCounts: { fits: 10, tight: 1, overflow: 0, unknown: 1 },
      contextConfidenceCounts: {
        contextExplicit: 5,
        contextDetected: 0,
        contextKnownCatalog: 4,
        contextCachedProvider: 2,
        contextConservativeFallback: 1,
        profileUnavailable: 0,
      },
      priceConfidenceCounts: { priceKnown: 12, priceUnknown: 0, profileUnavailable: 0 },
      tasks: [],
      totals: {
        knownActualEstimate: 0.14,
        hypotheticalAllPlanner: 1.2,
        estimatedSavings: 1.06,
        unknownCostReason: [],
      },
    },
  };
}

describe('CostApprovalPrompt', () => {
  beforeEach(() => {
    overlayStore.reset();
  });

  afterEach(() => {
    overlayStore.reset();
  });

  it('renders task count and cost estimate', () => {
    const ui = renderFeature(
      <CostApprovalPrompt prediction={makePrediction()} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    const output = ui.lastFrame() ?? '';
    expect(output).toContain('12 tasks');
    expect(output).toContain('Prompt input');
    expect(output).toContain('$0.14');
    expect(output).toContain('All-planner prompt');
    expect(output).toContain('~$1.20');
    expect(output).toContain('Prompt saving');
    expect(output).toContain(
      'Output, retries, validation reruns, and escalation are tracked at runtime.',
    );
    expect(output).toContain('Approve?');
    expect(output).not.toContain('Est.');
    ui.unmount();
  });

  it('renders an all-planner baseline when the actual estimate is unknown', () => {
    const prediction = makePrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    prediction.deterministic!.totals.estimatedSavings = null;

    const ui = renderFeature(
      <CostApprovalPrompt prediction={prediction} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    const output = ui.lastFrame() ?? '';

    expect(output).toContain('Prompt input');
    expect(output).toContain('n/a');
    expect(output).toContain('All-planner prompt');
    expect(output).toContain('~$1.20');
    ui.unmount();
  });

  it('approves the cost gate when y is pressed after the typeahead grace', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makePrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await tick(PAST_GRACE);
    ui.stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('rejects the cost gate when n is pressed after the typeahead grace', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makePrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await tick(PAST_GRACE);
    ui.stdin.write('n');
    expect(onReject).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ignores a keystroke that lands inside the typeahead grace window', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makePrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    // A 'y' buffered for the composer arrives the instant the cost prompt mounts. The grace
    // swallows it so a stray keystroke cannot auto-approve a spend the user never confirmed.
    ui.stdin.write('y');
    await tick(1);
    expect(onApprove).not.toHaveBeenCalled();

    await tick(PAST_GRACE);
    ui.stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('does not approve while an overlay is open, honours the key after it closes', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    overlayStore.open('settings');
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makePrediction()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    await tick(PAST_GRACE);

    // The prompt is hidden behind the overlay; an approve key aimed at the overlay must not
    // confirm the buried spend.
    ui.stdin.write('y');
    await tick(1);
    expect(onApprove).not.toHaveBeenCalled();

    // Closing the overlay returns input to the prompt and the same key is honoured.
    overlayStore.close();
    await tick(1);
    ui.stdin.write('y');
    expect(onApprove).toHaveBeenCalledOnce();
    ui.unmount();
  });
});
