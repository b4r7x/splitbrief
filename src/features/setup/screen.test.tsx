import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { routerStore } from '../../stores/navigation/router.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { SetupScreen } from './screen.js';

function makeConfig(): Config {
  return {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', persistTranscript: true },
  };
}

describe('SetupScreen', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    routerStore.init({ screen: 'setup' });
  });

  it('does not advertise Escape as quit when no planners are available', async () => {
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('No planner tools detected');
    expect(frame).not.toContain('Esc quit');
    expect(frame).toContain('run init again');

    ui.unmount();
  });
});
