import { describe, it, expect, beforeEach } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { PRICED_CATALOG } from '#testing/helpers/factories/model-cache.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { glyph } from '../../../lib/glyphs.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { CostDrilldownOverlay } from './overlay.js';

function unwrap(frame: string): string {
  return frame.replace(/[│|]/g, ' ').replace(/\s+/g, ' ');
}

/** Custom endpoints price by model id, so the drilldown needs catalog rates for those ids. */
function seedPricedCatalog(): void {
  modelCacheStore.reset();
  modelCacheStore.hydrateModelsDevCatalog({
    catalog: PRICED_CATALOG,
    fetchedAt: 1,
    validatedAt: 1,
  });
}

describe('CostDrilldownOverlay task metadata', () => {
  beforeEach(() => {
    seedPricedCatalog();
    tokensStore.__testReset();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
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
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Route hard task');
    expect(frame).toContain('profile cheap-local');
    expect(frame).toContain('fit tight');
    expect(frame).toContain('price unknown');
    expect(unwrap(frame)).toContain('why rerouted after context estimate exceeded cheap profile');
    ui.unmount();
  });

  it('strips terminal-control bytes from attempt profile and routing reason metadata', () => {
    tokensStore.__testReset({
      perTask: {
        T001: {
          title: 'Resumed hostile task',
          totalTokens: 150,
          attempts: [
            {
              method: 'local',
              implementerTokens: 150,
              escalationTokens: 0,
              retryCount: 0,
              implementerProfile: 'cheap\u001b]0;pwned\u0007-local',
              contextFit: 'tight',
              routingReason: 'rerouted\u001b[2J cleared',
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('profile cheap-local');
    expect(frame).toContain('why rerouted cleared');
    expect(frame).not.toContain('\u001b]0;');
    expect(frame).not.toContain('\u001b[2J');
    expect(frame).not.toContain('pwned');
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
    expect(frame).toContain('No task data yet');
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
    expect(frame).toContain('No task data yet');
    ui.unmount();
  });

  it('renders cache-only task attempts with non-zero totals and cache pricing state', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'custom-endpoint',
        implementerTool: 'custom-endpoint',
        implementerModel: 'deepseek-v4-flash',
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
              tool: 'custom-endpoint',
              model: 'deepseek-v4-flash',
              implementerCacheReadTokens: 1_000_000,
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Cache only task');
    expect(frame).toContain('1000.0k tok');
    expect(frame).toContain('price partially unknown');
    ui.unmount();
  });

  it('renders the focused phase cache fraction and never the cache n/a placeholder', () => {
    tokensStore.__testReset({
      perPhase: {
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

  it('renders metadata for every task row, not only the first sorted row', () => {
    tokensStore.__testReset({
      perTask: {
        T001: {
          title: 'Top task',
          totalTokens: 500,
          attempts: [
            {
              method: 'local',
              implementerTokens: 500,
              escalationTokens: 0,
              retryCount: 0,
              implementerProfile: 'cheap-cloud',
              contextFit: 'fits',
            },
          ],
        },
        T002: {
          title: 'Second task',
          totalTokens: 150,
          attempts: [
            {
              method: 'local',
              implementerTokens: 150,
              escalationTokens: 0,
              retryCount: 0,
              implementerProfile: 'cheap-local',
              contextFit: 'tight',
              costPosture: 'unknown-price',
              routingReason: 'rerouted after context estimate exceeded cheap profile',
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Second task');
    expect(frame).toContain('profile cheap-local');
    expect(frame).toContain('fit tight');
    expect(frame).toContain('price unknown');
    expect(frame).toContain('why rerouted after context estimate exceeded');
    ui.unmount();
  });
});

describe('CostDrilldownOverlay phase pricing', () => {
  beforeEach(() => {
    seedPricedCatalog();
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
    const ui = renderFeature(<CostDrilldownOverlay />);
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
    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('local');
    expect(frame).toContain('n/a');
    expect(frame).not.toContain('$0.00');
    ui.unmount();
  });

  it('derives priced phase bars from raw token data when store cost is zero', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'custom-endpoint',
        plannerModel: 'claude-sonnet-5',
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
    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planning');
    expect(frame).toContain('$12.00');
    ui.unmount();
  });

  it('prices planner and implementer portions of an implementer phase separately', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'custom-endpoint',
        plannerModel: 'claude-sonnet-5',
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
    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('implementing');
    expect(frame).toContain('$12.00');
    ui.unmount();
  });

  it('prices the final-review phase at the configured reviewer rates', () => {
    tokensStore.__testReset({
      pricingContext: {
        plannerTool: 'custom-endpoint',
        plannerModel: 'claude-sonnet-5',
        implementerTool: 'ollama',
        implementerModel: 'qwen2.5',
        reviewerTool: 'custom-endpoint',
        reviewerModel: 'claude-sonnet-5',
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
    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('final-review');
    expect(frame).toContain('$12.00');
    ui.unmount();
  });
});

describe('CostDrilldownOverlay seat breakdown', () => {
  const pricedSeats = {
    plannerTool: 'custom-endpoint',
    plannerModel: 'claude-sonnet-5',
    implementerTool: 'custom-endpoint',
    implementerModel: 'claude-sonnet-5',
  };

  beforeEach(() => {
    forceUnicodeGlyphs();
    seedPricedCatalog();
    tokensStore.__testReset();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  });

  it('shows the seat section once two seats have tokens', () => {
    tokensStore.__testReset({
      pricingContext: pricedSeats,
      tokenUsage: makeUsage({
        plannerInput: 20_000,
        plannerOutput: 4_000,
        implementerInput: 60_000,
        implementerOutput: 12_000,
      }),
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('By seat');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    ui.unmount();
  });

  it('hides the seat section when only one seat has tokens', () => {
    tokensStore.__testReset({
      pricingContext: pricedSeats,
      tokenUsage: makeUsage({ plannerInput: 20_000, plannerOutput: 4_000 }),
    });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain('By seat');
    ui.unmount();
  });

  const seedTwoSeats = () => {
    tokensStore.__testReset({
      pricingContext: pricedSeats,
      tokenUsage: makeUsage({
        plannerInput: 20_000,
        plannerOutput: 4_000,
        implementerInput: 60_000,
        implementerOutput: 12_000,
      }),
    });
  };

  const seatLine = (frame: string): string =>
    frame.split('\n').find((line) => line.includes('PLAN')) ?? '';

  it('drops the bar but keeps the share below sixty inner cells', () => {
    seedTwoSeats();
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const line = seatLine(stripAnsiStyles(ui.lastFrame() ?? ''));

    expect(line).toContain('%');
    expect(line).not.toContain(glyph('barFilled', 'unicode'));
    ui.unmount();
  });

  it('draws the bar once the inner width allows it', () => {
    seedTwoSeats();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });

    const ui = renderFeature(<CostDrilldownOverlay />);
    const line = seatLine(stripAnsiStyles(ui.lastFrame() ?? ''));

    expect(line).toContain('%');
    expect(line).toContain(glyph('barFilled', 'unicode'));
    ui.unmount();
  });
});
