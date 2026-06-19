import { describe, it, expect, beforeEach } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { tokensStore } from '../../../../stores/workflow/tokens.js';
import { CostDrilldownOverlay } from './drilldown-overlay.js';

describe('CostDrilldownOverlay task metadata', () => {
  beforeEach(() => {
    tokensStore.__testReset();
    terminalSizeStore.__testReset({ cols: 120 });
  });

  it('renders profile, context fit, routing reason, and cost interpretation for task attempts', () => {
    tokensStore.__testReset({
      perTask: {
        T001: {
          title: 'Route hard task',
          totalTokens: 150,
          attempts: [
            {
              method: 'local',
              implementerTokens: 150,
              escalationTokens: 0,
              retryCount: 0,
              implementerProfile: 'cheap-local',
              contextFit: 'tight',
              estimatedTokens: 95_000,
              contextLength: 100_000,
              costPosture: 'unknown-price',
              routingReason: 'rerouted after context estimate exceeded cheap profile',
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Route hard task');
    expect(frame).toContain('profile cheap-local');
    expect(frame).toContain('fit tight');
    expect(frame).toContain('price unknown');
    expect(frame).toContain('why rerouted after context estimate exceeded');
    expect(frame).toContain('cheap profile');
    ui.unmount();
  });

  it('hides task-start-only zero-token rows', () => {
    tokensStore.__testReset({
      perTask: {
        T001: { title: 'Started only', totalTokens: 0, attempts: [] },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('Started only');
    expect(frame).toContain('No task data yet.');
    ui.unmount();
  });

  it('hides all-zero task attempts as empty task data', () => {
    tokensStore.__testReset({
      perTask: {
        T001: {
          title: 'Zero attempt',
          totalTokens: 0,
          attempts: [
            {
              method: 'local',
              implementerTokens: 0,
              escalationTokens: 0,
              retryCount: 0,
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('Zero attempt');
    expect(frame).toContain('No task data yet.');
    ui.unmount();
  });

  it('renders cache-only task attempts with non-zero totals and cache pricing state', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-chat',
      },
      perTask: {
        T001: {
          title: 'Cache only task',
          totalTokens: 1_000_000,
          attempts: [
            {
              method: 'local',
              implementerTokens: 0,
              escalationTokens: 0,
              retryCount: 0,
              tool: 'deepseek',
              model: 'deepseek-chat',
              implementerCacheReadTokens: 1_000_000,
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Cache only task');
    expect(frame).toContain('1000.0k tokens (total)');
    expect(frame).toContain('price partially unknown');
    ui.unmount();
  });

  it('renders cache rows only when cache data is meaningful', () => {
    tokensStore.__testReset({
      perPhase: {
        planning: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
        implementing: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 100,
          cacheCreateTokens: 0,
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('cache 50%');
    expect(frame).not.toContain('cache n/a');
    ui.unmount();
  });

  it('renders cache-read-only phase data as meaningful cache data', () => {
    tokensStore.__testReset({
      perPhase: {
        planning: {
          inputTokens: 0,
          outputTokens: 20,
          cacheReadTokens: 100,
          cacheCreateTokens: 0,
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('cache 100%');
    expect(frame).not.toContain('cache n/a');
    ui.unmount();
  });

  it('omits routine routing reasons when fit and pricing are ordinary', () => {
    tokensStore.__testReset({
      perTask: {
        T001: {
          title: 'Routine task',
          totalTokens: 150,
          attempts: [
            {
              method: 'local',
              implementerTokens: 150,
              escalationTokens: 0,
              retryCount: 0,
              implementerProfile: 'cheap-cloud',
              contextFit: 'fits',
              estimatedTokens: 10_000,
              contextLength: 100_000,
              costPosture: 'Selected cheap cost tier via cheapest-capable routing',
              routingReason: 'selected cheapest capable profile',
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Routine task');
    expect(frame).toContain('profile cheap-cloud');
    expect(frame).toContain('fit fits');
    expect(frame).not.toContain('why selected cheapest capable profile');
    ui.unmount();
  });
});
