import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { SOFT_SEP } from '../../components/separators.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { glyph } from '../../lib/glyphs.js';
import { ContractRecap } from './sub-panel.js';
import { TextInputOverlay } from './text-input-overlay.js';

describe('TextInputOverlay', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
  });

  it('ignores typing and Enter while a foreign overlay is open, then accepts them once it closes', async () => {
    overlayStore.open('command-palette');
    const submitted: string[] = [];
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
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

    await flushEffects();
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

  it('renders one panel with a rounded input frame, accent prompt, and dim footer', async () => {
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        label="Command to run"
        placeholder="cmd"
        examples={['my-tool']}
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('╭').length - 1).toBe(2);
    expect(frame).toContain('Custom command');
    expect(frame).toContain('planner');
    expect(frame).toContain(`${glyph('prompt')} `);
    expect(frame).toContain(`⏎ save${SOFT_SEP}esc back`);
    expect(frame).toContain('e.g. my-tool');
    ui.unmount();
  });

  it('keeps the panel height fixed while a long command word-wraps to more input rows', async () => {
    const panelHeight = (frame: string): number => {
      const lines = frame.split('\n');
      const top = lines.findIndex((line) => line.includes('╭'));
      const bottom = lines.findLastIndex((line) => line.includes('╰'));
      return bottom - top + 1;
    };
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        label="Command to run"
        placeholder="cmd"
        helper="prompt on stdin"
        examples={['my-planner --json']}
        rows={1}
        maxRows={3}
        onSubmit={() => {}}
      />,
    );
    await tick(20);
    const initialFrame = ui.lastFrame() ?? '';
    const initialHeight = panelHeight(initialFrame);
    expect(initialFrame).toContain('prompt on stdin');
    expect(initialFrame).toContain('e.g. my-planner --json');

    // Word wrap yields three rendered rows here while perfect cell packing
    // would predict two — the yield must follow the actual rows.
    await flushEffects();
    ui.stdin.write(`${'a'.repeat(30)} ${'b'.repeat(30)} ${'c'.repeat(33)}`);
    await tick(20);
    await flushEffects();

    const grownFrame = ui.lastFrame() ?? '';
    expect(grownFrame).not.toContain('prompt on stdin');
    expect(grownFrame).not.toContain('e.g. my-planner --json');
    expect(panelHeight(grownFrame)).toBe(initialHeight);
    ui.unmount();
  });

  it('shows the full contract recap digest with an aligned chip at 60 cols', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 30, isSmall: true });
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        recap={<ContractRecap tier="output" />}
        label="Command to run"
        placeholder="cmd"
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    const bar = glyph('liveBar');
    const arrow = glyph('connectorHandoff');
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(
      `${bar}  OUTPUT  ${arrow} result from stdout${SOFT_SEP}no direct writes`,
    );

    ui.rerender(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        recap={<ContractRecap tier="direct" />}
        label="Command to run"
        placeholder="cmd"
        onSubmit={() => {}}
      />,
    );
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain(
      `${bar}  DIRECT  ${arrow} writes files directly${SOFT_SEP}stdout ignored`,
    );
    ui.unmount();
  });
});
