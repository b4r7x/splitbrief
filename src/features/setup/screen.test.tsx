import { beforeEach, describe, expect, it } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { routerStore } from '../../stores/navigation/router.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { SetupScreen } from './screen.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

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
