import { describe, expect, it } from 'vitest';
import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { rowLeading, rowLeadingCells, wrapWidthFor } from './row-markers.js';

describe('rowLeading', () => {
  it('gives headers a 2-cell glyph slot at column 0', () => {
    expect(rowLeadingCells('task-header')).toBe(2);
  });

  it('hangs tree children two cells under the header glyph', () => {
    expect(rowLeading('activity-child').startsWith('  ')).toBe(true);
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

  it('marks activity and task header rows with the live bullet marker', () => {
    expect(rowLeading('activity', 'live')).toBe(`${glyph('statusInProgress')} `);
  });

  it('keeps every activity-child leading at the same cell width as the gutter', () => {
    for (const kind of ['activity-child', 'activity-child-last', 'activity-more'] as const) {
      expect(rowLeadingCells(kind)).toBe(4);
    }
    expect(rowLeading('activity-child')).toBe(`  ${glyph('treeBranch')} `);
    expect(rowLeading('activity-child-last')).toBe(`  ${glyph('treeLast')} `);
    expect(rowLeading('activity-more')).toBe('    ');
    expect(rowLeadingCells('activity')).toBe(2);
  });

  it('emits status-specific header glyphs at a byte-stable width-2 prefix', () => {
    for (const kind of ['activity', 'task-header'] as const) {
      expect(rowLeading(kind)).toBe(`${glyph('statusInProgress')} `);
      expect(rowLeading(kind, 'live')).toBe(`${glyph('statusInProgress')} `);
      expect(rowLeading(kind, 'queued')).toBe(`${glyph('statusPending')} `);
      for (const status of ['live', 'done', 'queued'] as const) {
        expect(getTerminalCellWidth(rowLeading(kind, status))).toBe(2);
      }
    }
    expect(rowLeading('activity', 'done')).toBe(`${glyph('stageDone')} `);
    expect(rowLeading('task-header', 'done')).toBe(`${glyph('statusDone')} `);
  });

  it('encodes every header status with a distinct glyph so state survives a color-off terminal', () => {
    for (const kind of ['activity', 'task-header'] as const) {
      const leadings = (['live', 'done', 'queued'] as const).map((status) =>
        rowLeading(kind, status),
      );
      expect(leadings.every((leading) => leading.trim().length > 0)).toBe(true);
      expect(new Set(leadings).size).toBe(leadings.length);
    }
  });
});
