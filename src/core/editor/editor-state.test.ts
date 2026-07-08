import { describe, expect, it } from 'vitest';
import { visualPositionOf, wrapVisualLines } from './grapheme-motions.js';
import {
  applyEditorEvent,
  clampScrollTop,
  createEditorState,
  type EditorLayout,
  type EditorState,
  selectionRange,
  UNDO_RING_CAP,
} from './editor-state.js';

const L: EditorLayout = { columns: 5, rows: 10 };

function at(value: string, index: number) {
  return applyEditorEvent(createEditorState('field', value), { kind: 'set-cursor', index }, L);
}

// The PAINTED caret cell (row, col) as the render path resolves it: the reducer's affinity fed
// back through the single visualPositionOf oracle. Asserting this — not just the cursor index —
// is what locks the seam fix (the index-only assertion is the false-negative that shipped the bug).
const painted = (s: EditorState) =>
  visualPositionOf(wrapVisualLines(s.value, L.columns), s.cursor, s.affinity);

describe('selection', () => {
  it('a shifted motion sets the anchor at the pre-move cursor and extends it', () => {
    let s = at('hello world', 0);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'char-right', select: true }, L);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'char-right', select: true }, L);
    expect(s.anchor).toBe(0);
    expect(s.cursor).toBe(2);
    expect(selectionRange(s)).toEqual({ start: 0, end: 2 });
  });

  it('a shifted motion normalizes the range regardless of direction', () => {
    let s = at('hello world', 3);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'char-left', select: true }, L);
    expect(selectionRange(s)).toEqual({ start: 2, end: 3 });
  });

  it('a non-shifted motion collapses the selection', () => {
    let s = at('hello world', 0);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'char-right', select: true }, L);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'char-right', select: false }, L);
    expect(s.anchor).toBeNull();
    expect(selectionRange(s)).toBeNull();
  });

  it('select-all spans 0..end', () => {
    const s = applyEditorEvent(createEditorState('field', 'hello'), { kind: 'select-all' }, L);
    expect(selectionRange(s)).toEqual({ start: 0, end: 5 });
  });
});

describe('scroll follows the caret so stored scrollTop matches the rendered viewport (REQ-030)', () => {
  const layout: EditorLayout = { columns: 4, rows: 3 };
  const value = 'a'.repeat(40);

  it('advances scrollTop when a motion pushes the caret below the viewport', () => {
    let s = createEditorState('raw', value);
    expect(s.scrollTop).toBe(0);

    s = applyEditorEvent(s, { kind: 'motion', motion: 'doc-end', select: false }, layout);

    const { row } = visualPositionOf(wrapVisualLines(value, layout.columns), s.cursor);
    expect(s.scrollTop).toBeGreaterThan(0);
    expect(row).toBeGreaterThanOrEqual(s.scrollTop);
    expect(row).toBeLessThan(s.scrollTop + layout.rows);
  });

  it('leaves scrollTop untouched while the caret stays inside the viewport', () => {
    let s = createEditorState('field', 'hello world');
    s = applyEditorEvent(
      s,
      { kind: 'motion', motion: 'char-right', select: false },
      {
        columns: 40,
        rows: 5,
      },
    );
    expect(s.scrollTop).toBe(0);
  });

  it('clampScrollTop keeps the caret row inside [scrollTop, scrollTop+height)', () => {
    expect(clampScrollTop(0, 3, 5)).toBe(0);
    expect(clampScrollTop(9, 3, 0)).toBe(7);
    expect(clampScrollTop(4, 3, 4)).toBe(4);
    expect(clampScrollTop(2, 0, 5)).toBe(0);
  });
});

describe('edits replace the active selection range exactly', () => {
  function selected(value: string, start: number, end: number) {
    let s = at(value, start);
    s = applyEditorEvent(s, { kind: 'set-cursor', index: end, select: true }, L);
    return s;
  }

  it('typing replaces the selection and leaves the caret after the inserted text', () => {
    const s = applyEditorEvent(selected('hello world', 0, 2), { kind: 'insert', text: 'XY' }, L);
    expect(s.value).toBe('XYllo world');
    expect(s.cursor).toBe(2);
    expect(s.anchor).toBeNull();
  });

  it('paste replaces the selection', () => {
    const s = applyEditorEvent(
      selected('hello world', 0, 5),
      { kind: 'insert', text: 'bye', paste: true },
      L,
    );
    expect(s.value).toBe('bye world');
  });

  it('delete removes exactly the selection range', () => {
    const s = applyEditorEvent(
      selected('hello world', 0, 6),
      { kind: 'delete', dir: 'backward', unit: 'char' },
      L,
    );
    expect(s.value).toBe('world');
    expect(s.cursor).toBe(0);
  });
});

describe('a non-selection char delete removes exactly one whole grapheme cluster', () => {
  it('backward-deletes a skin-tone emoji cluster as a single unit', () => {
    const value = '\u{1F44D}\u{1F3FD}x';
    const s = applyEditorEvent(at(value, 4), { kind: 'delete', dir: 'backward', unit: 'char' }, L);
    expect(s.value).toBe('x');
    expect(s.cursor).toBe(0);
  });

  it('forward-deletes a ZWJ family cluster as a single unit', () => {
    const value = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}x';
    const s = applyEditorEvent(at(value, 0), { kind: 'delete', dir: 'forward', unit: 'char' }, L);
    expect(s.value).toBe('x');
    expect(s.cursor).toBe(0);
  });
});

describe('insert normalizes to NFC and keeps the caret after the text', () => {
  it('collapses a base+combining sequence into one NFC code unit', () => {
    const s = applyEditorEvent(createEditorState('field', ''), { kind: 'insert', text: 'é' }, L);
    expect(s.value).toBe('é'.normalize('NFC'));
    expect(s.value.length).toBe(1);
    expect(s.cursor).toBe(1);
  });
});

describe('goal column', () => {
  it('sticks across consecutive vertical motions over a short middle row', () => {
    let s = at('abcde\nfg\nhijkl', 14);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, L);
    expect(s.goalCol).toBe(5);
    expect(s.cursor).toBe(8);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, L);
    expect(s.goalCol).toBe(5);
    expect(s.cursor).toBe(5);
  });

  it('resets on a horizontal motion', () => {
    let s = at('abcdefghij', 10);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, L);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'char-left', select: false }, L);
    expect(s.goalCol).toBeNull();
  });

  it('resets on an insert', () => {
    let s = at('abcdefghij', 10);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, L);
    s = applyEditorEvent(s, { kind: 'insert', text: 'z' }, L);
    expect(s.goalCol).toBeNull();
  });

  it('a vertical motion whose goal exceeds a non-final wrapped row lands at that row end, not the next row', () => {
    const value = 'abcd中efg';
    let s = at(value, value.length);
    expect(s.cursor).toBe(8);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, L);
    expect(s.goalCol).toBe(5);
    expect(s.cursor).toBe(4);
  });
});

describe('a cursor resting on a soft-wrap boundary acts on the upper visual row (the rendered caret row)', () => {
  const value = 'aaaaaaaa\nbbbbb';

  it('line-start moves to the start of the upper wrapped row, not the lower one', () => {
    let s = at(value, 5);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'line-start', select: false }, L);
    expect(s.cursor).toBe(0);
  });

  it('down steps from the upper row into the short middle row, not past it', () => {
    let s = at(value, 5);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, L);
    expect(s.cursor).toBe(8);
  });

  it('down from column 0 of a soft-wrapped row advances one visual row per press without stalling at the seam', () => {
    // 'abcdefghijklmno' at columns=5 wraps into rows [0,5]/[5,10]/[10,15]; indices 5 and 10 are
    // soft-wrap seams. Pre-affinity, first-match-wins painted these as (0,5)/(1,5) — the stall.
    let s = at('abcdefghijklmno', 0);
    expect(painted(s)).toEqual({ row: 0, col: 0 });
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, L);
    expect(s.cursor).toBe(5);
    expect(s.affinity).toBe('downstream');
    expect(painted(s)).toEqual({ row: 1, col: 0 });
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, L);
    expect(s.cursor).toBe(10);
    expect(s.affinity).toBe('downstream');
    expect(painted(s)).toEqual({ row: 2, col: 0 });
  });

  it('shift+line-start selects the whole upper row', () => {
    let s = at(value, 5);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'line-start', select: true }, L);
    expect(selectionRange(s)).toEqual({ start: 0, end: 5 });
  });

  it('backward delete-to-line-start removes the upper row content', () => {
    let s = at(value, 5);
    s = applyEditorEvent(s, { kind: 'delete', dir: 'backward', unit: 'line' }, L);
    expect(s.value).toBe('aaa\nbbbbb');
    expect(s.cursor).toBe(0);
  });
});

describe('caret affinity keeps the painted (row,col) consistent with the model at a soft-wrap seam', () => {
  it('DOWN onto a seam sets downstream affinity and paints column 0 of the lower row (REQ-103/105)', () => {
    // 'abcdefghij' at columns=5 wraps into rows [0,5]/[5,10]; index 5 is the seam.
    let s = at('abcdefghij', 0);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, L);
    expect(s.cursor).toBe(5);
    expect(s.affinity).toBe('downstream');
    expect(painted(s)).toEqual({ row: 1, col: 0 });
  });

  it('UP onto a seam sets upstream affinity and paints the upper row end, not the lower row start (REQ-106)', () => {
    // 'abcd中efg' at columns=5 wraps into row0 'abcd' (width 4) and row1 '中efg' (width 5); index 4
    // is the seam. UP from the end must paint (0,4) — the upper row's display-width — not (1,0).
    let s = at('abcd中efg', 8);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, L);
    expect(s.cursor).toBe(4);
    expect(s.affinity).toBe('upstream');
    expect(painted(s)).toEqual({ row: 0, col: 4 });
  });

  it('DOWN on the last visual row is a stable rest with no seam-guard advance or out-of-range access (REQ-107)', () => {
    let s = at('abcdefghijklmno', 12); // last row [10,15], painted (2,2)
    expect(painted(s)).toEqual({ row: 2, col: 2 });
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, L);
    expect(s.cursor).toBe(12);
    expect(s.affinity).toBe('upstream');
    expect(painted(s)).toEqual({ row: 2, col: 2 });
  });

  it('a wide/CJK seam agrees on model and painted column: DOWN → col 0, UP → display-width (REQ-108)', () => {
    let down = at('abcd中efg', 0);
    down = applyEditorEvent(down, { kind: 'motion', motion: 'down', select: false }, L);
    expect(down.cursor).toBe(4);
    expect(down.affinity).toBe('downstream');
    expect(painted(down)).toEqual({ row: 1, col: 0 });

    let up = at('abcd中efg', 8);
    up = applyEditorEvent(up, { kind: 'motion', motion: 'up', select: false }, L);
    expect(up.cursor).toBe(4);
    expect(up.affinity).toBe('upstream');
    expect(painted(up)).toEqual({ row: 0, col: 4 });
  });
});

describe('vertical-nav affinity follows the landed row, not the motion direction (REQ-103/104)', () => {
  // columns=4 wraps 'abcdefghij' into rows [0,4]'abcd' / [4,8]'efgh' / [8,10]'ij'; indices 4 and 8
  // are soft-wrap seams. The paint oracle uses the reducer's affinity, so a direction-only choice
  // regresses these traces (Down landing on a row END, or Up landing on a row START).
  const C4: EditorLayout = { columns: 4, rows: 10 };
  const at4 = (value: string, index: number) =>
    applyEditorEvent(createEditorState('field', value), { kind: 'set-cursor', index }, C4);
  const painted4 = (s: EditorState) =>
    visualPositionOf(wrapVisualLines(s.value, C4.columns), s.cursor, s.affinity);

  it('End then Down lands on the target row end (1,4), not the row below (2,0)', () => {
    let s = at4('abcdefghij', 0);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'line-end', select: false }, C4);
    expect(painted4(s)).toEqual({ row: 0, col: 4 });
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, C4);
    expect(s.cursor).toBe(8);
    expect(s.affinity).toBe('upstream');
    expect(painted4(s)).toEqual({ row: 1, col: 4 });
  });

  it('repeated Down at a full goal column visits every visual row 0→1→2→3→4 with no skip or early bottom', () => {
    // 5 rows: [0,4]/[4,8]/[8,12]/[12,16]/[16,20]; goal column 4 lands each row on its end.
    let s = at4('abcdefghijklmnopqrst', 0);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'line-end', select: false }, C4);
    expect(painted4(s)).toEqual({ row: 0, col: 4 });
    for (const row of [1, 2, 3, 4]) {
      s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, C4);
      expect(painted4(s).row).toBe(row);
      expect(painted4(s).col).toBe(4);
    }
    expect(s.cursor).toBe(20);
    // A further Down rests on the last row without advancing or throwing.
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, C4);
    expect(painted4(s)).toEqual({ row: 4, col: 4 });
    expect(s.cursor).toBe(20);
  });

  it('Down to the bottom then Up steps (2,0)→(1,0)→(0,0) with no skip at the seam', () => {
    // Mirror of case 1: an Up landing on a row START seam must paint that target row (downstream),
    // not jump to the upper row end. Direction-only affinity forced the first Up to (0,4).
    let s = at4('abcdefghij', 0);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, C4);
    s = applyEditorEvent(s, { kind: 'motion', motion: 'down', select: false }, C4);
    expect(s.cursor).toBe(8);
    expect(painted4(s)).toEqual({ row: 2, col: 0 });

    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, C4);
    expect(s.cursor).toBe(4);
    expect(s.affinity).toBe('downstream');
    expect(painted4(s)).toEqual({ row: 1, col: 0 });

    s = applyEditorEvent(s, { kind: 'motion', motion: 'up', select: false }, C4);
    expect(s.cursor).toBe(0);
    expect(painted4(s)).toEqual({ row: 0, col: 0 });
  });
});

describe('undo and redo', () => {
  it('coalesces consecutive inserts into a single undo unit', () => {
    let s = createEditorState('field', '');
    s = applyEditorEvent(s, { kind: 'insert', text: 'a' }, L);
    s = applyEditorEvent(s, { kind: 'insert', text: 'b' }, L);
    expect(s.value).toBe('ab');
    expect(s.undo.length).toBe(1);
    const undone = applyEditorEvent(s, { kind: 'undo' }, L);
    expect(undone.value).toBe('');
    expect(undone.redo.length).toBe(1);
  });

  it('redo reapplies the last undone snapshot', () => {
    let s = createEditorState('field', '');
    s = applyEditorEvent(s, { kind: 'insert', text: 'a' }, L);
    const undone = applyEditorEvent(s, { kind: 'undo' }, L);
    const redone = applyEditorEvent(undone, { kind: 'redo' }, L);
    expect(redone.value).toBe('a');
  });

  it('a new edit clears the redo stack', () => {
    let s = createEditorState('field', '');
    s = applyEditorEvent(s, { kind: 'insert', text: 'a' }, L);
    const undone = applyEditorEvent(s, { kind: 'undo' }, L);
    const edited = applyEditorEvent(undone, { kind: 'insert', text: 'z' }, L);
    expect(edited.redo.length).toBe(0);
  });

  it('newline, delete, and paste start a fresh undo boundary', () => {
    let s = createEditorState('field', '');
    s = applyEditorEvent(s, { kind: 'insert', text: 'a' }, L);
    s = applyEditorEvent(s, { kind: 'insert', text: '\n' }, L);
    expect(s.undo.length).toBe(2);
  });

  it('a paste is one undo unit that fully reverts', () => {
    let s = createEditorState('field', '');
    s = applyEditorEvent(s, { kind: 'insert', text: 'hello pasted body', paste: true }, L);
    expect(s.undo.length).toBe(1);
    expect(s.lastEditClass).toBe('paste');
    const undone = applyEditorEvent(s, { kind: 'undo' }, L);
    expect(undone.value).toBe('');
  });

  it('caps the undo ring at UNDO_RING_CAP, dropping the oldest snapshot while still restoring', () => {
    let s = createEditorState('field', '');
    for (let i = 0; i < UNDO_RING_CAP + 50; i++) {
      s = applyEditorEvent(s, { kind: 'insert', text: 'x' }, L);
      s = applyEditorEvent(s, { kind: 'insert', text: '\n' }, L);
    }
    expect(s.undo.length).toBe(UNDO_RING_CAP);
    const valueBefore = s.value;
    const undone = applyEditorEvent(s, { kind: 'undo' }, L);
    expect(undone.value).not.toBe(valueBefore);
    expect(undone.value.length).toBeLessThan(valueBefore.length);
  });
});
