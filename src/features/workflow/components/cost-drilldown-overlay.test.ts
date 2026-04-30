import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import {
  buildPhaseRows,
  buildTaskRows,
  CostDrilldownOverlay,
  renderBar,
  formatCacheHitPct,
  formatCacheCreateTokens,
  formatInputOutputSplit,
  formatTotalTokens,
  formatPhaseCost,
  calculatePhaseRowCost,
} from './cost-drilldown-overlay.js';
import { resolvePricing } from '../../../engine/providers/pricing-resolver.js';

describe('buildPhaseRows', () => {
  it('returns empty array for empty perPhase', () => {
    expect(buildPhaseRows({})).toEqual([]);
  });

  it('sorts by cost descending', () => {
    const rows = buildPhaseRows({
      planning: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0.01 },
      implementing: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 100, cacheCreateTokens: 0, cost: 0.05 },
      validating: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0.003 },
    });
    expect(rows.map(r => r.phase)).toEqual(['implementing', 'planning', 'validating']);
  });

  it('can sort by a derived display cost when store rows keep raw token data', () => {
    const pricing = resolvePricing('anthropic', undefined, 'claude-sonnet-4-6');
    const rows = buildPhaseRows({
      planning: {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        cost: 0,
      },
      'reviewing-plan': {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        cost: 0,
      },
    }, row => calculatePhaseRowCost(row, pricing, null));

    expect(rows.map(r => r.phase)).toEqual(['reviewing-plan', 'planning']);
    expect(rows[0]?.cost).toBeGreaterThan(0);
  });
});

describe('CostDrilldownOverlay', () => {
  it('renders real phase cost and cache data from the store', () => {
    tokensStore.__testReset({
      perPhase: {
        planning: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 250,
          cacheCreateTokens: 125,
          cost: 0.03,
        },
      },
    });
    terminalSizeStore.__testReset({ cols: 100 });

    const ui = render(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planning');
    expect(frame).toContain('$0.03');
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
          cost: 0,
        },
        implementing: {
          inputTokens: 2000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          cost: 0,
        },
      },
    });
    terminalSizeStore.__testReset({ cols: 100 });

    const ui = render(createElement(CostDrilldownOverlay));
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
          cost: 0,
        },
      },
    });
    terminalSizeStore.__testReset({ cols: 100 });

    const ui = render(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planning');
    expect(frame).toContain('$18.00');
    expect(frame).toContain('█');
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
          cost: 0,
        },
      },
    });
    terminalSizeStore.__testReset({ cols: 100 });

    const ui = render(createElement(CostDrilldownOverlay));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('implementing');
    expect(frame).toContain('$18.00');
    expect(frame).toContain('█');
    ui.unmount();
  });
});

describe('buildTaskRows', () => {
  it('returns empty array for empty perTask', () => {
    expect(buildTaskRows({})).toEqual([]);
  });

  it('sorts by totalTokens descending', () => {
    const rows = buildTaskRows({
      task1: { totalTokens: 200, cost: 0.01, title: 'First task' },
      task2: { totalTokens: 800, cost: 0.04, title: 'Second task' },
      task3: { totalTokens: 50, cost: 0.002, title: 'Third task' },
    });
    expect(rows.map(r => r.taskId)).toEqual(['task2', 'task1', 'task3']);
  });
});

describe('renderBar', () => {
  it('returns empty string when max is 0', () => {
    expect(renderBar(0, 0, 10)).toBe('');
    expect(renderBar(5, 0, 10)).toBe('');
  });

  it('returns full bar when value equals max', () => {
    expect(renderBar(10, 10, 10)).toBe('█'.repeat(10));
  });

  it('returns correct proportional bar', () => {
    const bar = renderBar(5, 10, 10);
    expect(bar).toBe('█████░░░░░');
  });

  it('returns empty bar when value is 0', () => {
    const bar = renderBar(0, 10, 10);
    expect(bar).toBe('░'.repeat(10));
  });
});

describe('formatCacheHitPct', () => {
  it('returns cache n/a when cacheRead is 0', () => {
    expect(formatCacheHitPct(0, 500)).toBe('cache n/a');
  });

  it('returns cache n/a when input is 0', () => {
    expect(formatCacheHitPct(100, 0)).toBe('cache n/a');
  });

  it('returns correct percentage', () => {
    // cacheRead / (cacheRead + input) — 200 / (200 + 800) = 20%
    expect(formatCacheHitPct(200, 800)).toBe('cache 20%');
  });

  it('returns 50% for equal cacheRead and input', () => {
    expect(formatCacheHitPct(500, 500)).toBe('cache 50%');
  });
});

describe('formatInputOutputSplit', () => {
  it('shows raw numbers when total <= 1000', () => {
    expect(formatInputOutputSplit(300, 200)).toBe('in: 300 / out: 200');
  });

  it('scales to k when total > 1000', () => {
    expect(formatInputOutputSplit(1500, 500)).toBe('in: 1.5k / out: 0.5k');
  });
});

describe('formatCacheCreateTokens', () => {
  it('returns empty string when cache creation is unsupported or absent', () => {
    expect(formatCacheCreateTokens(0)).toBe('');
  });

  it('scales cache creation tokens', () => {
    expect(formatCacheCreateTokens(1500)).toBe('create 1.5k');
  });
});

describe('formatTotalTokens', () => {
  it('includes (total) suffix', () => {
    expect(formatTotalTokens(500)).toContain('(total)');
  });

  it('shows raw count when <= 1000', () => {
    expect(formatTotalTokens(500)).toBe('500 tokens (total)');
  });

  it('scales to k when > 1000', () => {
    expect(formatTotalTokens(2500)).toBe('2.5k tokens (total)');
  });
});

describe('formatPhaseCost', () => {
  it('labels zero-cost unpriced phases explicitly', () => {
    expect(formatPhaseCost(0, false, 'unpriced-local')).toBe('local');
    expect(formatPhaseCost(0, false, 'unpriced-cli')).toBe('unpriced');
    expect(formatPhaseCost(0, false, 'unpriced-meta')).toBe('unpriced');
    expect(formatPhaseCost(0, false, 'unpriced-unknown')).toBe('n/a');
    expect(formatPhaseCost(0, false, null)).toBe('n/a');
  });
});
