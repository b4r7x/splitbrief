import { beforeEach, describe, expect, it } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { ModeSelector } from './mode-selector.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

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
