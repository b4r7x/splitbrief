import { describe, it, expect, beforeEach } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { glyph } from '../../../lib/glyphs.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { CostDrilldownOverlay } from './overlay.js';

function unwrap(frame: string): string {
  return frame.replace(/[│|]/g, ' ').replace(/\s+/g, ' ');
}

describe('CostDrilldownOverlay task metadata', () => {
  beforeEach(() => {
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
        plannerTool: 'anthropic',
        implementerTool: 'deepseek',
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
              tool: 'deepseek',
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

describe('CostDrilldownOverlay seat breakdown', () => {
  const pricedSeats = {
    plannerTool: 'anthropic',
    plannerModel: 'claude-sonnet-4-6',
    implementerTool: 'anthropic',
    implementerModel: 'claude-sonnet-4-6',
  };

  beforeEach(() => {
    forceUnicodeGlyphs();
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
