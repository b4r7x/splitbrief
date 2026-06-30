import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { glyph } from '../../lib/glyphs.js';
import { TextInputOverlay } from './text-input-overlay.js';

describe('TextInputOverlay', () => {
  beforeEach(() => resetAllStores());

  it('ignores typing and Enter while a foreign overlay is open, then accepts them once it closes', async () => {
    overlayStore.open('command-palette');
    const submitted: string[] = [];
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom Command"
        label="Command to run:"
        placeholder="cmd"
        onSubmit={(value) => {
          submitted.push(value);
        }}
      />,
    );
    await tick(20);

    ui.stdin.write('abc');
    await tick(20);
    expect(ui.lastFrame()).not.toContain('abc');

    ui.stdin.write('\r');
    await tick(20);
    expect(submitted).toEqual([]);

    overlayStore.close();
    await tick(20);

    ui.stdin.write('hello');
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    expect(submitted).toEqual(['hello']);
    ui.unmount();
  });

  it('renders a single rounded input frame with an accent prompt and dim footer', async () => {
    const ui = renderFeature(
      <TextInputOverlay
        title="custom command"
        label="command to run"
        placeholder="cmd"
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('╭').length - 1).toBe(1);
    expect(frame).toContain(`${glyph('prompt')} `);
    expect(frame).toContain('⏎ save · esc back');
    ui.unmount();
  });
});
