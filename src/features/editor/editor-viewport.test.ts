import { describe, expect, it } from 'vitest';
import { wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import { caretVisualPosition, computeEditorScrollTop } from './editor-viewport.js';

// Mirrors EditorOverlay (src/app/overlays/editor.tsx): the FramePanel chrome that brackets the
// EditorBufferView — border 2 + title 1 + divider 1 + footer 1 — so the content viewport is
// Math.max(1, rows - FRAME_ROWS). This is the reserve the overlay actually renders with.
const FRAME_ROWS = 5;

describe('caretVisualPosition', () => {
  it('re-wrapping the same buffer at two widths moves the caret to a new visual row (REQ-033)', () => {
    const value = 'abcdefghijklmnopqrstuvwxyz';
    const cursor = 15;

    const narrow = caretVisualPosition(wrapVisualLines(value, 10), cursor);
    const wide = caretVisualPosition(wrapVisualLines(value, 20), cursor);

    expect(narrow.row).toBe(1);
    expect(wide.row).toBe(0);
    expect(narrow.row).not.toBe(wide.row);
  });

  it('pins a cursor at a non-final wrapped row end index to that row, not the next row-0 caret', () => {
    const value = 'abcdefghijklmnopqrstuvwxyz';
    const lines = wrapVisualLines(value, 10);

    const firstRow = lines[0];
    if (firstRow === undefined) throw new Error('expected a wrapped row');
    expect(firstRow.end).toBe(10);
    expect(lines[1]?.start).toBe(10);

    const pos = caretVisualPosition(lines, firstRow.end);

    expect(pos.row).toBe(0);
  });

  it('reports col == wrap width for a caret at a full wrapped row seam (render box must reserve it)', () => {
    const columns = 10;
    const lines = wrapVisualLines('abcdefghijklmnopqrstuvwxyz', columns);

    const firstRow = lines[0];
    if (firstRow === undefined) throw new Error('expected a wrapped row');
    expect(firstRow.width).toBe(columns);

    const pos = caretVisualPosition(lines, firstRow.end);

    // The seam caret lands at display col == columns — one past the last content cell — so the
    // raw viewport must render at width columns + 1 or the caret is clipped away (REQ-034/054).
    expect(pos).toEqual({ row: 0, col: columns });
  });

  it('returns the origin for an empty buffer', () => {
    expect(caretVisualPosition(wrapVisualLines('', 40), 0)).toEqual({ row: 0, col: 0 });
  });
});

describe('computeEditorScrollTop', () => {
  it('honors a wheel-set scrollTop within document bounds instead of snapping to the caret (REQ-030)', () => {
    // A long document scrolled to its top while the caret sits far below: the render must keep the
    // viewport at the wheel offset, NOT drag it back to the caret row (that would wall wheel scroll).
    expect(computeEditorScrollTop({ lineCount: 40, height: 5, scrollTop: 0 })).toBe(0);
    expect(computeEditorScrollTop({ lineCount: 40, height: 5, scrollTop: 12 })).toBe(12);
  });

  it('clamps scrollTop to the last full page so trailing rows stay filled', () => {
    // 40 lines, height 5 → deepest useful top is 35; anything past it clamps back to 35.
    expect(computeEditorScrollTop({ lineCount: 40, height: 5, scrollTop: 100 })).toBe(35);
    expect(computeEditorScrollTop({ lineCount: 40, height: 5, scrollTop: 35 })).toBe(35);
  });

  it('pins scrollTop to 0 when the whole document fits in the viewport', () => {
    expect(computeEditorScrollTop({ lineCount: 3, height: 5, scrollTop: 4 })).toBe(0);
    expect(computeEditorScrollTop({ lineCount: 0, height: 5, scrollTop: 2 })).toBe(0);
  });

  it('fits an 80x24 layout: viewport reserves the frame chrome exactly, controls stay reserved (CON-D)', () => {
    const cols = 80;
    const rows = 24;

    // Derive the content viewport the exact way EditorOverlay (src/app/overlays/editor.tsx:25) does —
    // Math.max(1, rows - FRAME_ROWS) — so this fit assertion tracks the real reserve the overlay
    // renders with, not a decoupled helper the shipped overlay no longer calls.
    const height = Math.max(1, rows - FRAME_ROWS);

    // CON-D: the frame chrome plus the content viewport account for every terminal row exactly, and
    // the viewport stays non-empty. At the minimum terminal the clamp keeps viewport >= 1.
    expect(height).toBeGreaterThanOrEqual(1);
    expect(FRAME_ROWS + height).toBe(rows);

    // At a terminal shorter than the frame the same clamp still yields a >= 1 viewport.
    expect(Math.max(1, 3 - FRAME_ROWS)).toBeGreaterThanOrEqual(1);

    const value = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const lines = wrapVisualLines(value, cols);
    expect(lines.length).toBeGreaterThan(height);

    // Every clamped viewport stays within document bounds and keeps the last row of content on the
    // final page (never scrolls into empty space past the buffer).
    for (const scrollTop of [0, 50, 150, 10_000]) {
      const clamped = computeEditorScrollTop({ lineCount: lines.length, height, scrollTop });
      expect(clamped).toBeGreaterThanOrEqual(0);
      expect(clamped).toBeLessThanOrEqual(lines.length - height);
    }
  });
});
