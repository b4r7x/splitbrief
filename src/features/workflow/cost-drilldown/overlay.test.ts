import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderFeature } from '#testing/helpers/ink.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { CostDrilldownOverlay } from './overlay.js';

describe('CostDrilldownOverlay', () => {
  beforeEach(() => {
    tokensStore.__testReset();
    terminalSizeStore.__testReset({ cols: 100, rows: 40 });
  });

  it('renders real phase cost and cache data from the store', () => {
    tokensStore.__testReset({
      perPhase: {
        planning: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 250,
          cacheCreateTokens: 125,
        },
      },
    });
    const ui = renderFeature(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planning');
    expect(frame).toContain('cache 20%');
    expect(frame).toContain('create 125');
    ui.unmount();
  });

  it('renders local/unpriced/n/a labels instead of fake zero costs for unpriced phases', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'ollama',
        plannerModel: 'qwen2.5',
        implementerTool: 'unknown-tool',
        implementerModel: 'unknown-model',
      },
      perPhase: {
        planning: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
        implementing: {
          inputTokens: 2000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      },
    });
    const ui = renderFeature(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('local');
    expect(frame).toContain('n/a');
    expect(frame).not.toContain('$0.00');
    ui.unmount();
  });

  it('derives priced phase bars from raw token data when store cost is zero', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-4-6',
        implementerTool: 'ollama',
        implementerModel: 'qwen2.5',
      },
      perPhase: {
        planning: {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      },
    });
    const ui = renderFeature(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planning');
    expect(frame).toContain('$18.00');
    ui.unmount();
  });

  it('prices planner and implementer portions of an implementer phase separately', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-4-6',
        implementerTool: 'ollama',
        implementerModel: 'qwen2.5',
      },
      perPhase: {
        implementing: {
          inputTokens: 3_000_000,
          outputTokens: 2_000_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          plannerInputTokens: 1_000_000,
          plannerOutputTokens: 1_000_000,
          plannerCacheReadTokens: 0,
          plannerCacheCreateTokens: 0,
          implementerInputTokens: 2_000_000,
          implementerOutputTokens: 1_000_000,
          implementerCacheReadTokens: 0,
          implementerCacheCreateTokens: 0,
        },
      },
    });
    const ui = renderFeature(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('implementing');
    expect(frame).toContain('$18.00');
    ui.unmount();
  });

  it('prices the final-review phase at the configured reviewer rates', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-4-6',
        implementerTool: 'ollama',
        implementerModel: 'qwen2.5',
        reviewerTool: 'anthropic',
        reviewerModel: 'claude-sonnet-4-6',
      },
      perPhase: {
        'final-review': {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          plannerInputTokens: 0,
          plannerOutputTokens: 0,
          plannerCacheReadTokens: 0,
          plannerCacheCreateTokens: 0,
          implementerInputTokens: 0,
          implementerOutputTokens: 0,
          implementerCacheReadTokens: 0,
          implementerCacheCreateTokens: 0,
          reviewerInputTokens: 1_000_000,
          reviewerOutputTokens: 1_000_000,
          reviewerCacheReadTokens: 0,
          reviewerCacheCreateTokens: 0,
        },
      },
    });
    const ui = renderFeature(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('final-review');
    expect(frame).toContain('$18.00');
    ui.unmount();
  });
});
