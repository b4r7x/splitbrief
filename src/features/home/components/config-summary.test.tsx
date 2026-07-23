import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
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
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
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
    expect(stripped).toContain('Ollama');
    expect(stripped).toContain('Llama');
    expect(stripped).toContain('Mistral');
    ui.unmount();
  });
});
