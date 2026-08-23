import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { configStore } from '../../../stores/project/config.js';
import { HomeConfigSummary } from './config-summary.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC52_IMPL = `${ESC}]52;c;SGFjaw==${BEL}`;
const OSC52_PLANNER = `${ESC}]52;c;cHduZWQ=${BEL}`;
const evilImplModel = `mistral${OSC52_IMPL}${ESC}[2J`;
const evilPlannerModel = `llama${OSC52_PLANNER}${ESC}[31m`;

function seedEvilModels(): void {
  configStore.__testReset({
    config: makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        apiBase: 'https://openrouter.ai/api/v1',
        model: evilPlannerModel,
      },
      implementer: { model: evilImplModel },
    }),
    projectDir: '/tmp/home-config-summary-test',
  });
}

function expectNoControlBytes(frame: string): void {
  expect(frame).not.toContain(BEL);
  expect(frame).not.toContain(`${ESC}]`);
  expect(frame).not.toContain(']52;c;');
  expect(frame).not.toContain('SGFjaw==');
  expect(frame).not.toContain('cHduZWQ=');
}

describe('HomeConfigSummary', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('strips OSC-52/CSI control bytes from runner model labels', async () => {
    seedEvilModels();

    const ui = renderFeature(<HomeConfigSummary />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expectNoControlBytes(frame);
    const stripped = stripAnsiStyles(frame);
    expect(stripped).toContain('OpenRouter');
    expect(stripped).toContain('Ollama');
    expect(stripped).toContain('Llama');
    expect(stripped).toContain('Mistral');
    ui.unmount();
  });

  it('names two seats with no reviewer configured and three with one', async () => {
    configStore.__testReset({
      config: makeConfig(),
      projectDir: '/tmp/home-config-summary-test',
    });

    const twoSeats = renderFeature(<HomeConfigSummary />);
    await tick(20);
    expect(stripAnsiStyles(twoSeats.lastFrame() ?? '')).not.toContain('DeepSeek');
    twoSeats.unmount();

    configStore.__testReset({
      config: makeConfig({
        reviewer: {
          kind: 'api',
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          model: 'deepseek-reasoner',
        },
      }),
      projectDir: '/tmp/home-config-summary-test',
    });

    const threeSeats = renderFeature(<HomeConfigSummary />, { cols: 60, rows: 18 });
    await tick(20);
    const frame = stripAnsiStyles(threeSeats.lastFrame() ?? '');
    expect(frame).toContain('DeepSeek');
    const lines = frame.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(getTerminalCellWidth(lines[0] ?? '')).toBeLessThanOrEqual(60);
    threeSeats.unmount();
  });
});
