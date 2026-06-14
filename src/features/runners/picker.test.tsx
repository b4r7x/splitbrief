import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { ToolModelPicker } from './picker.js';

const DOWN = '\u001B[B';
const ESC = '\u001B';

async function openCustomCommand(ui: ReturnType<typeof renderFeature>) {
  for (let i = 0; i < 30; i++) {
    if (ui.lastFrame()?.includes('Run a custom command as the')) break;
    ui.stdin.write(DOWN);
    await tick(10);
  }
  expect(ui.lastFrame()).toContain('Run a custom command as the');
  ui.stdin.write('\r'); // Enter on the special row opens the custom-command input
  await vi.waitFor(() => {
    expect(ui.lastFrame() ?? '').toContain('Command to run:');
  });
}

describe('ToolModelPicker custom-command input', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
  });

  it('does not close the text input on Escape while a foreign overlay is open', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    await openCustomCommand(ui);

    overlayStore.open('command-palette');
    await tick(20);

    ui.stdin.write(ESC); // ignored while the palette is on top
    await tick(20);
    expect(ui.lastFrame()).toContain('Command to run:'); // still in the text-input view

    overlayStore.close();
    await tick(20);

    ui.stdin.write(ESC); // now reaches the picker and returns to the tool list
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('Command to run:'); // left the text-input view
      expect(frame).toContain('Tools'); // back on the two-column picker view
      expect(frame).toContain('Models');
    });
    ui.unmount();
  });
});
