import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { foldRow, withFoldHint } from './fold-row.js';
import { rowText } from './row-format/rows.js';

const HELD = ['+15 briefs', '62 files', '3 reviews'];

function fold(width: number, expanded = false) {
  return foldRow({ foldKey: 'batch', expanded, hidden: HELD, width });
}

describe('foldRow', () => {
  it('says what it holds while closed and collapse while open, under the key of its fold', () => {
    expect(fold(120)).toMatchObject({ key: 'batch-hidden', kind: 'activity-more' });
    expect(rowText(fold(120))).toBe('+15 briefs · 62 files · 3 reviews');
    expect(rowText(fold(120, true))).toBe('collapse');
  });

  it('drops what does not fit from the right, and keeps room for the key', () => {
    expect(rowText(fold(45))).toBe('+15 briefs · 62 files · 3 reviews');
    expect(rowText(fold(44))).toBe('+15 briefs · 62 files');
    expect(rowText(fold(32))).toBe('+15 briefs');
    const cut = rowText(fold(17));
    expect(cut.endsWith('…')).toBe(true);
    expect(getTerminalCellWidth(cut)).toBe(5);
  });
});

describe('withFoldHint', () => {
  it('names the activity key after the words of the row, in the same tone', () => {
    const hinted = withFoldHint(fold(45));

    expect(rowText(hinted)).toBe('+15 briefs · 62 files · 3 reviews · ctrl+a');
    expect(hinted.key).toBe('batch-hidden');
    expect(hinted.segments.every((segment) => segment.tone === 'textDim')).toBe(true);
    expect(rowText(withFoldHint(fold(45, true)))).toBe('collapse · ctrl+a');
  });
});
