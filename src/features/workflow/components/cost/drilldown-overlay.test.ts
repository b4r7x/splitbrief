import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { tokensStore } from '../../../../stores/workflow/tokens.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  buildPhaseRows,
  buildTaskRows,
  CostDrilldownOverlay,
  renderBar,
  formatCacheCreateTokens,
  formatInputOutputSplit,
  formatTotalTokens,
  formatPhaseCost,
  calculatePhaseRowCost,
} from './drilldown-overlay.js';
import { resolvePricing } from '../../../../engine/providers/pricing-resolver.js';

describe('buildPhaseRows', () => {
  it('returns empty array for empty perPhase', () => {
    expect(buildPhaseRows({})).toEqual([]);
  });

  it('sorts by cost descending', () => {
    const rows = buildPhaseRows({
      planning: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0.01 },
      implementing: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 100, cacheCreateTokens: 0, cost: 0.05 },
      'validating-task': { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0.003 },
    });
    expect(rows.map(r => r.phase)).toEqual(['implementing', 'planning', 'validating-task']);
  });

  it('can sort by a derived display cost when store rows keep raw token data', () => {
    const pricing = resolvePricing('anthropic', undefined, 'claude-sonnet-4-6');
    const rows = buildPhaseRows({
      planning: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 },
      'reviewing-plan': { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 },
    }, row => calculatePhaseRowCost(row, pricing, null));

    expect(rows.map(r => r.phase)).toEqual(['reviewing-plan', 'planning']);
    expect(rows[0]?.cost).toBeGreaterThan(0);
  });
});

describe('CostDrilldownOverlay', () => {
  it('renders real phase cost and cache data from the store', () => {
    tokensStore.__testReset({
      perPhase: {
        planning: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 250, cacheCreateTokens: 125, cost: 0.03 },
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
        planning: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 },
        implementing: { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 },
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
        planning: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 },
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
  it.each([
    [0, 0, 10, ''],
    [5, 0, 10, ''],
    [10, 10, 10, '██████████'],
    [5, 10, 10, '█████░░░░░'],
    [0, 10, 10, '░░░░░░░░░░'],
  ] as const)('renderBar(%i, %i, %i) → %s', (value, max, width, expected) => {
    expect(renderBar(value, max, width)).toBe(expected);
  });
});

describe('formatInputOutputSplit', () => {
  it.each([
    [300, 200, 'in: 300 / out: 200'],
    [1500, 500, 'in: 1.5k / out: 0.5k'],
  ] as const)('formatInputOutputSplit(%i, %i) → %s', (input, output, expected) => {
    expect(formatInputOutputSplit(input, output)).toBe(expected);
  });
});

describe('formatCacheCreateTokens', () => {
  it.each([
    [0, ''],
    [1500, 'create 1.5k'],
  ] as const)('formatCacheCreateTokens(%i) → %s', (tokens, expected) => {
    expect(formatCacheCreateTokens(tokens)).toBe(expected);
  });
});

describe('formatTotalTokens', () => {
  it.each([
    [500, '500 tokens (total)'],
    [2500, '2.5k tokens (total)'],
  ] as const)('formatTotalTokens(%i) → %s', (tokens, expected) => {
    expect(formatTotalTokens(tokens)).toBe(expected);
  });
});

describe('formatPhaseCost', () => {
  it.each([
    [0, false, 'unpriced-local' as const, 'local'],
    [0, false, 'unpriced-cli' as const, 'unpriced'],
    [0, false, 'unpriced-meta' as const, 'unpriced'],
    [0, false, 'unpriced-unknown' as const, 'n/a'],
    [0, false, null, 'n/a'],
  ] as const)('formatPhaseCost(%i, %s, %s) → %s', (cost, isDerived, reason, expected) => {
    expect(formatPhaseCost(cost, isDerived, reason)).toBe(expected);
  });
});
