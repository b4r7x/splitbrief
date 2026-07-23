import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { editorStore } from '../../stores/ui/editor.js';
import { EditorBufferView } from './editor-buffer-view.js';

describe('EditorBufferView', () => {
  // The seam caret is a background-styled space; ink-testing-library defaults colours off, which
  // would strip the style and let Ink trim the trailing space, hiding the very cell under test.
  // Force a colour level so the inverse caret cell is emitted and observable (REQ-034).
  let restoreChalkLevel: 0 | 1 | 2 | 3;

  beforeEach(() => {
    restoreChalkLevel = chalk.level;
    chalk.level = 3;
    resetAllStores();
  });

  afterEach(() => {
    chalk.level = restoreChalkLevel;
    resetAllStores();
  });

  it('renders the end-of-row caret cell for a caret at a full wrapped row seam (not clipped)', async () => {
    const columns = 8;
    // 'ABCDEFGH' exactly fills a wrapped row of width 8; 'ijkl' spills to the next row, so the
    // seam caret at index 8 sits at the non-final full row's end (display col == columns).
    editorStore.openRaw({
      filePath: null,
      value: 'ABCDEFGHijkl',
      ownerToken: 1,
      layout: { columns, rows: 4 },
    });
    editorStore.dispatch({ kind: 'motion', motion: 'line-end', select: false });

    const ui = renderFeature(<EditorBufferView />);
    await tick();
    const frame = ui.lastFrame() ?? '';
    const lines = stripAnsiStyles(frame).split('\n');
    ui.unmount();

    // The first visual row keeps all 8 content cells AND the reserved trailing caret cell, so its
    // rendered width is columns + 1 — proof the caret at the seam survived the render box.
    expect(lines[0]).toBe('ABCDEFGH ');
    expect(lines[1]).toBe('ijkl');
    // The caret renders as an inverse-styled cell (REQ-034): the seam space carries a background
    // style, so the raw (styled) frame differs from the stripped frame on the first row.
    expect(frame.split('\n')[0]).not.toBe('ABCDEFGH ');
    // Absolute cursor positioning (CUP/HVP/DECSLRM) must not appear in captured terminal output;
    // SGR styling for the inverse caret is allowed.
    const esc = String.fromCharCode(0x1b);
    expect(frame).not.toMatch(new RegExp(`${esc}\\[[0-9]*;?[0-9]*[Hf]`));
    expect(frame).not.toMatch(new RegExp(`${esc}\\[[0-9]+;[0-9]+s`));
  });

  it('wheel-scrolls the viewport away from the caret to reveal top-of-document rows (REQ-030)', async () => {
    const columns = 10;
    const rows = 4;
    // 30 distinct unwrapped rows: caret parks at the bottom, wheel must reach the top.
    const value = Array.from({ length: 30 }, (_, i) => `row-${String(i).padStart(2, '0')}`).join(
      '\n',
    );
    editorStore.openRaw({ filePath: null, value, ownerToken: 1, layout: { columns, rows } });
    // Caret-follow (REQ-029) pushes the viewport to the bottom so the caret is on-screen.
    editorStore.dispatch({ kind: 'motion', motion: 'doc-end', select: false });

    const ui = renderFeature(<EditorBufferView />);
    await tick();
    // The caret is at the doc end, so the bottom rows are what's initially painted, not the top.
    expect(stripAnsiStyles(ui.lastFrame() ?? '').split('\n')).not.toContain('row-00');

    // A wheel-up nudge past the caret must move the rendered viewport, not snap back to the caret.
    editorStore.scrollBy(-100);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    ui.unmount();

    // Top-of-document rows are now visible — the render honored the wheel offset (would fail if the
    // paint re-clamped scrollTop back to the caret row near the document end).
    expect(lines[0]).toBe('row-00');
    expect(lines).toContain('row-03');
    expect(lines).not.toContain('row-29');
  });
});
