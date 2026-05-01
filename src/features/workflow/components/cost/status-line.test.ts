import { beforeEach, describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../../../stores/project/config.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { tokensStore } from '../../../../stores/workflow/tokens.js';
import {
  CostStatusLine,
  formatProjected,
  formatBudget,
  formatCachePct,
} from './status-line.js';

describe('formatProjected', () => {
  it('returns rolling average when tasks completed', () => {
    // 2 tasks completed, $2.00 spent, 4 total → projected $4.00
    expect(formatProjected(2, 2.0, null, 4)).toBe('proj $4.00');
  });

  it('falls back to prediction.expectedCost when no tasks completed', () => {
    const prediction = { estimatedTasks: 4, lowCost: 1, expectedCost: 3.5, highCost: 6, plannerTool: 'x', implementerTool: 'y' };
    expect(formatProjected(0, 0, prediction, 4)).toBe('proj $3.50');
  });

  it('returns proj n/a when neither completed tasks nor prediction available', () => {
    expect(formatProjected(0, 0, null, 4)).toBe('proj n/a');
  });

  it('uses rolling avg even when prediction is present', () => {
    const prediction = { estimatedTasks: 4, lowCost: 1, expectedCost: 3.5, highCost: 6, plannerTool: 'x', implementerTool: 'y' };
    expect(formatProjected(1, 1.0, prediction, 4)).toBe('proj $4.00');
  });
});

describe('formatBudget', () => {
  it('returns empty string when maxBudget is undefined', () => {
    expect(formatBudget(undefined)).toBe('');
  });

  it('returns formatted cost when maxBudget is defined', () => {
    expect(formatBudget(10)).toBe('$10.00');
    expect(formatBudget(0.5)).toBe('$0.50');
  });
});

describe('formatCachePct', () => {
  it('returns cache n/a when cacheRead is undefined', () => {
    expect(formatCachePct(undefined, 1000)).toBe('cache n/a');
  });

  it('returns cache n/a when both cacheRead and input are zero', () => {
    expect(formatCachePct(0, 0)).toBe('cache n/a');
  });

  it('returns cache n/a when cacheRead is zero', () => {
    expect(formatCachePct(0, 1000)).toBe('cache n/a');
  });

  it('returns cache percentage when data is present', () => {
    // 500 cache out of 500+500 total = 50%
    expect(formatCachePct(500, 500)).toBe('cache 50%');
  });

  it('rounds percentage correctly', () => {
    // 1 cache, 2 input → 1/(1+2) = 33%
    expect(formatCachePct(1, 2)).toBe('cache 33%');
  });
});

describe('CostStatusLine', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders a narrow one-row fallback without budget or cache columns', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ workflow: { mode: 'standard', maxBudget: 10 } }),
    });
    terminalSizeStore.__testReset({ cols: 48 });
    tokensStore.__testReset({
      tokenUsage: {
        plannerInput: 100,
        plannerOutput: 50,
        implementerInput: 200,
        implementerOutput: 100,
        escalationInput: 0,
        escalationOutput: 0,
        plannerCacheRead: 25,
      },
      perPhase: {
        planning: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 25,
          cacheCreateTokens: 0,
          cost: 0.01,
        },
      },
    });

    const ui = render(createElement(CostStatusLine));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('mode: standard');
    expect(frame).toContain('spent');
    expect(frame).not.toContain('budget');
    expect(frame).not.toContain('cache');
    expect(frame.split('\n')).toHaveLength(1);
    ui.unmount();
  });

  it('renders local instead of a fake zero cost for all-local usage', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'ollama',
          model: 'qwen2.5',
          apiBase: 'http://localhost:11434/v1',
        },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
        },
        workflow: { mode: 'standard' },
      }),
    });
    terminalSizeStore.__testReset({ cols: 100 });
    tokensStore.__testReset({
      tokenUsage: {
        plannerInput: 1000,
        plannerOutput: 500,
        implementerInput: 2000,
        implementerOutput: 1000,
        escalationInput: 0,
        escalationOutput: 0,
      },
    });

    const ui = render(createElement(CostStatusLine));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('spent local');
    expect(frame).toContain('proj n/a');
    expect(frame).not.toContain('spent $0.00');
    ui.unmount();
  });

  it('renders unpriced instead of a fake zero cost for CLI/subscription usage', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'default' },
        implementer: { kind: 'cli', tool: 'codex', model: 'default' },
        workflow: { mode: 'quick' },
      }),
    });
    terminalSizeStore.__testReset({ cols: 100 });
    tokensStore.__testReset({
      tokenUsage: {
        plannerInput: 1000,
        plannerOutput: 500,
        implementerInput: 2000,
        implementerOutput: 1000,
        escalationInput: 0,
        escalationOutput: 0,
      },
    });

    const ui = render(createElement(CostStatusLine));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('spent unpriced');
    expect(frame).not.toContain('spent $0.00');
    ui.unmount();
  });

  it('renders n/a when no token cost breakdown exists yet', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ workflow: { mode: 'standard' } }),
    });
    terminalSizeStore.__testReset({ cols: 100 });

    const ui = render(createElement(CostStatusLine));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('spent n/a');
    expect(frame).not.toContain('spent $0.00');
    ui.unmount();
  });
});
