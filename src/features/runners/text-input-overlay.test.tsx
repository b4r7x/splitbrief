import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { SOFT_SEP } from '../../components/separators.js';
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
        title="Custom command"
        label="Command to run"
        placeholder="cmd"
        onSubmit={(value) => {
          submitted.push(value);
        }}
      />,
    );
    await flushEffects();

    ui.stdin.write('abc');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('abc');

    ui.stdin.write('\r');
    await flushEffects();
    expect(submitted).toEqual([]);

    overlayStore.close();
    await flushEffects();

    ui.stdin.write('hello');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(submitted).toEqual(['hello']);
    ui.unmount();
  });

  it('renders a single rounded input frame with an accent prompt and dim footer', async () => {
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        label="Command to run"
        placeholder="cmd"
        examples={['my-tool']}
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('╭').length - 1).toBe(1);
    expect(frame).toContain(`${glyph('prompt')} `);
    expect(frame).toContain(`⏎ save${SOFT_SEP}esc back`);
    expect(frame).toContain('Examples');
    ui.unmount();
  });
});
