import { beforeEach, describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../../../stores/project/config.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { tasksStore } from '../../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../../stores/workflow/tokens.js';
import { CostStatusLine } from './status-line.js';

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
        },
      },
    });

    const ui = render(createElement(CostStatusLine));
    const frame = ui.lastFrame() ?? '';

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

  it('includes nonzero escalation input and cache reads in efficiency stats', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-6',
        },
        implementer: {
          kind: 'api',
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        workflow: { mode: 'standard' },
      }),
    });
    terminalSizeStore.__testReset({ cols: 120 });
    tasksStore.__testReset({ totalTasks: 2 });
    tokensStore.__testReset({
      localCount: 1,
      escalatedCount: 1,
      completedTaskCount: 1,
      tokenUsage: {
        plannerInput: 1000,
        plannerOutput: 100,
        implementerInput: 2000,
        implementerOutput: 200,
        escalationInput: 1000,
        escalationOutput: 100,
        plannerCacheRead: 1000,
      },
      perPhase: {
        planning: {
          inputTokens: 2000,
          outputTokens: 200,
          cacheReadTokens: 500,
          cacheCreateTokens: 0,
          plannerInputTokens: 2000,
          implementerInputTokens: 0,
        },
        implementing: {
          inputTokens: 2000,
          outputTokens: 200,
          cacheReadTokens: 500,
          cacheCreateTokens: 0,
          plannerInputTokens: 0,
          implementerInputTokens: 2000,
        },
      },
    });

    const ui = render(createElement(CostStatusLine));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('plan 50%');
    expect(frame).toContain('cache 20%');
    ui.unmount();
  });

  it('divides the cache-hit ratio by the perPhase input, not the cumulative tokenUsage', () => {
    // Regression for F-457: on resume perPhase restarts empty while the
    // persisted tokenUsage stays cumulative, so the two must not be mixed in
    // one ratio. The numerator (cacheReadTokens) was already perPhase-based;
    // the bug was the denominator. Here the perPhase input (1000) is much
    // smaller than the cumulative tokenUsage input (9000), so the basis is
    // observable: folding the denominator from perPhase yields cache 50%
    // (1000 / (1000 + 1000)), while a regression back to the cumulative
    // tokenUsage denominator would render cache 10% (1000 / (1000 + 9000)).
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-6',
        },
        implementer: {
          kind: 'api',
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        workflow: { mode: 'standard' },
      }),
    });
    terminalSizeStore.__testReset({ cols: 120 });
    tokensStore.__testReset({
      tokenUsage: {
        plannerInput: 4000,
        plannerOutput: 500,
        implementerInput: 5000,
        implementerOutput: 500,
        escalationInput: 0,
        escalationOutput: 0,
        plannerCacheRead: 1000,
      },
      perPhase: {
        implementing: {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 1000,
          cacheCreateTokens: 0,
          plannerInputTokens: 0,
          implementerInputTokens: 1000,
        },
      },
    });

    const ui = render(createElement(CostStatusLine));
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('cache 50%');
    expect(frame).not.toContain('cache 10%');
    ui.unmount();
  });
});
