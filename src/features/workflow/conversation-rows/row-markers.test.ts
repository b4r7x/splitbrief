import { describe, expect, it } from 'vitest';
import { rowLeading, rowLeadingCells, wrapWidthFor } from './row-markers.js';

describe('rowLeading', () => {
  it('gives headers a 2-cell glyph slot at column 0', () => {
    expect(rowLeadingCells('activity')).toBe(2);
    expect(rowLeadingCells('task-header')).toBe(2);
    expect(rowLeading('activity', 'done').endsWith(' ')).toBe(true);
  });

  it('hangs tree children two cells under the header glyph', () => {
    expect(rowLeadingCells('activity-child')).toBe(4);
    expect(rowLeading('activity-child').startsWith('  ')).toBe(true);
    expect(rowLeadingCells('activity-more')).toBe(4);
  });

  it('gives plain rows a blank 2-cell slot and the prompt its marker', () => {
    expect(rowLeadingCells('message')).toBe(2);
    expect(rowLeading('message')).toBe('  ');
    expect(rowLeadingCells('prompt')).toBe(2);
    expect(rowLeading('prompt')).not.toBe('  ');
  });

  it('puts the callout rule in the glyph slot', () => {
    expect(rowLeadingCells('callout-top')).toBe(2);
    expect(rowLeading('callout-top')).toBe(rowLeading('callout-body'));
  });

  it('derives wrap width from the row leading width', () => {
    expect(wrapWidthFor('message', 10)).toBe(8);
    expect(wrapWidthFor('activity-child', 2)).toBe(1);
  });
});
