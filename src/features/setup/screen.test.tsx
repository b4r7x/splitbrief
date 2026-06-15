import { beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
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

  it('shows the no-planners screen when only the always-available shell planner is detected', async () => {
    detectionStore.setDetection({
      planners: [
        { tool: 'claude-code', type: 'cli', available: false, description: 'Claude Code' },
        { tool: 'shell', type: 'shell', available: true, description: 'Custom command' },
      ],
      implementers: [],
    });

    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('No planner tools detected');

    ui.unmount();
  });

  it('renders the planner picker when a non-shell planner is available', async () => {
    detectionStore.setDetection({
      planners: [
        { tool: 'claude-code', type: 'cli', available: true, description: 'Claude Code' },
        { tool: 'shell', type: 'shell', available: true, description: 'Custom command' },
      ],
      implementers: [],
    });

    const ui = renderFeature(
      <SetupScreen renderToolPicker={({ stepLabel }) => <Text>{stepLabel}</Text>} />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('No planner tools detected');
    expect(frame).toContain('Choose Planner (1/2)');

    ui.unmount();
  });
});
