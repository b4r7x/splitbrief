import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorLayout } from '../../core/editor/editor-state.js';
import { visualPositionOf, wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import { reviewStore } from '../workflow/review.js';
import { editorStore } from './editor.js';

const LAYOUT: EditorLayout = { columns: 80, rows: 24 };

beforeEach(() => {
  editorStore.reset();
  reviewStore.reset();
});

afterEach(() => {
  editorStore.reset();
  reviewStore.reset();
});

describe('editorStore ownership capture', () => {
  it('openRaw and openField capture the owner token at open time', () => {
    editorStore.openRaw({ filePath: 'spec.md', value: 'body', ownerToken: 7, layout: LAYOUT });
    const raw = editorStore.get();
    expect(raw.status).toBe('open');
    if (raw.status !== 'open') throw new Error('expected open');
    expect(raw.ownerToken).toBe(7);
    expect(raw.surface).toBe('raw');

    editorStore.openField({ filePath: 'tasks.md', value: 'body', ownerToken: 9, layout: LAYOUT });
    const field = editorStore.get();
    if (field.status !== 'open') throw new Error('expected open');
    expect(field.ownerToken).toBe(9);
    expect(field.surface).toBe('field');
  });
});

describe('editorStore scrollBy', () => {
  it('moves scrollTop by the delta and clamps at the top', () => {
    const value = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    editorStore.openRaw({ filePath: 'spec.md', value, ownerToken: 1, layout: LAYOUT });
    expect(editorStore.get()).toMatchObject({ scrollTop: 0 });

    editorStore.scrollBy(3);
    expect(editorStore.get()).toMatchObject({ scrollTop: 3 });

    editorStore.scrollBy(-1);
    expect(editorStore.get()).toMatchObject({ scrollTop: 2 });

    editorStore.scrollBy(-5);
    expect(editorStore.get()).toMatchObject({ scrollTop: 0 });
  });

  it('clamps to the document bottom so over-scrolling down never dead-zones the way back up', () => {
    const layout: EditorLayout = { columns: 80, rows: 5 };
    const value = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    editorStore.openRaw({ filePath: 'spec.md', value, ownerToken: 1, layout });

    editorStore.scrollBy(1000);
    expect(editorStore.get()).toMatchObject({ scrollTop: 35 });

    editorStore.scrollBy(-1);
    expect(editorStore.get()).toMatchObject({ scrollTop: 34 });
  });

  it('is a no-op while no session is open', () => {
    editorStore.scrollBy(4);
    expect(editorStore.get().status).toBe('closed');
  });
});

describe('editorStore wheel scroll origin after keyboard navigation', () => {
  it('syncs scrollTop on caret motion so scrollBy nudges from what is displayed, not a stale origin', () => {
    const layout: EditorLayout = { columns: 4, rows: 3 };
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openRaw({ filePath: 'spec.md', value: 'a'.repeat(40), ownerToken: owner, layout });

    editorStore.dispatch({ kind: 'motion', motion: 'doc-end', select: false });
    const afterMotion = editorStore.get();
    if (afterMotion.status !== 'open') throw new Error('expected open');
    expect(afterMotion.scrollTop).toBeGreaterThan(0);

    const origin = afterMotion.scrollTop;
    editorStore.scrollBy(-1);
    const scrolled = editorStore.get();
    if (scrolled.status !== 'open') throw new Error('expected open');
    expect(scrolled.scrollTop).toBe(origin - 1);
  });
});

describe('editorStore setLayout re-follows the caret after reflow', () => {
  it('keeps the caret in the visible window when a narrower width re-wraps it lower', () => {
    const owner = reviewStore.setReviewFile('spec.md');
    editorStore.openRaw({
      filePath: 'spec.md',
      value: 'a'.repeat(40),
      ownerToken: owner,
      layout: { columns: 10, rows: 3 },
    });

    editorStore.dispatch({ kind: 'motion', motion: 'doc-end', select: false });
    const wide = editorStore.get();
    if (wide.status !== 'open') throw new Error('expected open');
    expect(wide.scrollTop).toBeGreaterThan(0);

    editorStore.setLayout({ columns: 4, rows: 3 });
    const narrow = editorStore.get();
    if (narrow.status !== 'open') throw new Error('expected open');

    const lines = wrapVisualLines(narrow.value, narrow.layout.columns);
    const { row } = visualPositionOf(lines, narrow.cursor);
    expect(row).toBeGreaterThanOrEqual(narrow.scrollTop);
    expect(row).toBeLessThan(narrow.scrollTop + narrow.layout.rows);
  });
});
