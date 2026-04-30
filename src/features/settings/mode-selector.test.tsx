import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { ModeSelector } from './mode-selector.js';

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
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', persistTranscript: true, mode: 'standard' },
  };
}

describe('ModeSelector', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    overlayStore.reset();
    feedbackStore.reset();
  });

  it('renders planner call counts that match current workflow mode semantics', async () => {
    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('instant');
    expect(frame).toContain('1 call');
    expect(frame).toContain('standard');
    expect(frame).toContain('4 calls');
    expect(frame).toContain('speckit');
    expect(frame).toContain('6-7 calls');

    ui.unmount();
  });
});
