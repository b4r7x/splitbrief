import { describe, expect, it } from 'vitest';
import { focusBarCells, rowLeadingCells, rowMarkerCells } from './row-markers.js';

describe('rowLeadingCells', () => {
  it('reserves enough width for both the focus bar and task-header markers', () => {
    expect(rowLeadingCells('task-header')).toBe(focusBarCells() + rowMarkerCells('task-header'));
    expect(rowLeadingCells('activity')).toBe(focusBarCells() + rowMarkerCells('activity'));
  });

  it('reserves focus-bar width for rows without markers', () => {
    expect(rowLeadingCells('message')).toBe(focusBarCells());
  });
});
