import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { Box } from 'ink';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { visualPositionOf, wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { editorStore } from '../../stores/ui/editor.js';
import { FieldEditorView } from './field-editor-view.js';

const ESC = String.fromCharCode(27);

// The display column at which the row's first styled (caret/highlight) cell begins. Plain content
// carries no SGR in EditorBufferView, so everything before the first escape is unstyled: its
// display width IS the styled run's start column.
function firstStyledCol(row: string | undefined): number | null {
  if (row === undefined) return null;
  const at = row.indexOf(ESC);
  if (at === -1) return null;
  return getTerminalCellWidth(row.slice(0, at));
}

// The {start, width} of a row's single contiguous styled run (a fully-selected wrapped row, or a
// lone caret). Content between the first and last escape, stripped of SGR, is the styled cells.
function styledSpan(row: string | undefined): { start: number; width: number } | null {
  if (row === undefined) return null;
  const first = row.indexOf(ESC);
  const last = row.lastIndexOf(ESC);
  if (first === -1) return null;
  return {
    start: getTerminalCellWidth(row.slice(0, first)),
    width: getTerminalCellWidth(stripAnsiStyles(row.slice(first, last))),
  };
}

function openColumns(): number {
  const s = editorStore.get();
  if (s.status !== 'open') throw new Error('expected an open editor session');
  return s.layout.columns;
}

// A 16-cell buffer whose grapheme CHAR-wrap at 10 columns splits the word 'cdefghijkl' mid-word —
// ['ab cdefghi', 'jkl mn'] — where Ink's wrap-ansi WORD-wrap (the old ControlledMultilineInput
// paint) would instead break at the spaces into ['ab', 'cdefghijkl', 'mn']. Every assertion below
// therefore fails against the word-wrapped paint and passes only once the field surface paints
// through wrapVisualLines at the measured width (CON-F: model wrap oracle == painted oracle).
const VALUE = 'ab cdefghijkl mn';
const BOX_WIDTH = 11; // → columns 10 after the seam-caret reserve (width − 1)

describe('FieldEditorView model == painted (CON-F)', () => {
  let restoreChalkLevel: 0 | 1 | 2 | 3;

  beforeEach(() => {
    restoreChalkLevel = chalk.level;
    chalk.level = 3; // emit the caret/highlight SGR so styled cells are observable
    resetAllStores();
  });

  afterEach(() => {
    chalk.level = restoreChalkLevel;
    resetAllStores();
  });

  function render() {
    // The field session is seeded with a deliberately WRONG (full-terminal) width, exactly as the
    // Ctrl+E trigger does; the view must measure its own box and correct layout.columns.
    editorStore.openField({
      filePath: null,
      value: VALUE,
      ownerToken: 1,
      layout: { columns: 80, rows: 24 },
    });
    const ui = renderFeature(
      <Box width={BOX_WIDTH}>
        <FieldEditorView />
      </Box>,
    );
    return ui;
  }

  it('seeds layout.columns from the measured render box, reserving the seam-caret column', async () => {
    const ui = render();
    await tick();
    ui.unmount();
    // measured render width 11 − 1 seam column == 10; the reducer now wraps at exactly this width.
    expect(openColumns()).toBe(BOX_WIDTH - 1);
  });

  it('paints each field line with the reducer grapheme char-wrap, not Ink word-wrap', async () => {
    const ui = render();
    await tick();
    const columns = openColumns();
    const painted = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    ui.unmount();

    const expected = wrapVisualLines(VALUE, columns).map((line) => line.text);
    expect(expected).toEqual(['ab cdefghi', 'jkl mn']); // char-wrap splits 'cdefghijkl' mid-word
    expect(painted[0]).toBe(expected[0]); // word-wrap paint would put 'ab' here → desync
    expect(painted[1]).toBe(expected[1]);
  });

  it('lands the caret on the painted cell after a Down then End across a wrap boundary', async () => {
    const ui = render();
    await tick();
    const columns = openColumns();

    // Start mid-row-0 (col 2) so Down carries goalCol 2 onto row 1 without hitting the seam
    // ambiguity of column 0; the model index and the paint agree because both wrap at `columns`.
    editorStore.dispatch({ kind: 'set-cursor', index: 2 });
    editorStore.dispatch({ kind: 'motion', motion: 'down', select: false });
    await tick();
    {
      const s = editorStore.get();
      if (s.status !== 'open') throw new Error('closed');
      const pos = visualPositionOf(wrapVisualLines(s.value, columns), s.cursor);
      expect(pos).toEqual({ row: 1, col: 2 });
      const rows = (ui.lastFrame() ?? '').split('\n');
      expect(firstStyledCol(rows[pos.row])).toBe(pos.col);
    }

    editorStore.dispatch({ kind: 'motion', motion: 'line-end', select: false });
    await tick();
    {
      const s = editorStore.get();
      if (s.status !== 'open') throw new Error('closed');
      const pos = visualPositionOf(wrapVisualLines(s.value, columns), s.cursor);
      expect(pos).toEqual({ row: 1, col: 6 }); // end of 'jkl mn'
      const rows = (ui.lastFrame() ?? '').split('\n');
      // The end-of-line caret is the reserved seam cell one past the last content column.
      expect(firstStyledCol(rows[pos.row])).toBe(pos.col);
    }
    ui.unmount();
  });

  it('clamps layout.rows to maxRows so a tall field never outgrows its region (CON-D)', async () => {
    // 15 newline-separated lines wrap to 15 visual lines regardless of width; clampFieldRows would
    // otherwise seat the viewport at FIELD_MAX_ROWS=12. maxRows=8 must win so the enclosing region
    // keeps room for the identity/error/controls chrome the parent reserves.
    const value = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
    editorStore.openField({
      filePath: null,
      value,
      ownerToken: 1,
      layout: { columns: 80, rows: 24 },
    });
    const ui = renderFeature(
      <Box width={40}>
        <FieldEditorView maxRows={8} />
      </Box>,
    );
    await tick();
    const s = editorStore.get();
    ui.unmount();
    if (s.status !== 'open') throw new Error('expected an open editor session');
    expect(s.layout.rows).toBe(8); // not clampFieldRows(15) === 12
  });

  it('highlights exactly the painted cells a selection covers on a wrapped row', async () => {
    const ui = render();
    await tick();
    const columns = openColumns();

    editorStore.dispatch({ kind: 'select-all' });
    await tick();
    const rows = (ui.lastFrame() ?? '').split('\n');
    ui.unmount();

    const line0 = wrapVisualLines(VALUE, columns)[0];
    if (line0 === undefined) throw new Error('expected a wrapped row');
    // Row 0 is fully inside the selection: the whole painted row is one highlight run covering
    // every content cell — start 0, width == the row's display width (10), not the word-wrap 'ab'.
    expect(stripAnsiStyles(rows[0] ?? '')).toBe(line0.text);
    expect(styledSpan(rows[0])).toEqual({ start: 0, width: line0.width });
    expect(line0.width).toBe(columns);
  });
});
