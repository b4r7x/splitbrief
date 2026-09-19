import { describe, expect, it } from 'vitest';
import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { rowLeading, rowLeadingCells, wrapWidthFor } from './row-markers.js';
import type { ConversationRowKind } from './types.js';

describe('rowLeading', () => {
  it('gives plain rows a blank mark slot and the prompt its marker', () => {
    expect(rowLeadingCells('message')).toBe(3);
    expect(rowLeading('message')).toBe('   ');
    expect(rowLeadingCells('prompt')).toBe(3);
    expect(rowLeading('prompt')).toBe(` ${glyph('promptMarker')} `);
  });

  it('puts the callout rule in the glyph slot', () => {
    expect(rowLeadingCells('callout-top')).toBe(3);
    expect(rowLeading('callout-top')).toBe(` ${glyph('treeMid')} `);
    expect(rowLeading('callout-top')).toBe(rowLeading('callout-body'));
  });

  it('derives wrap width from the row leading width', () => {
    expect(wrapWidthFor('message', 10)).toBe(7);
    expect(wrapWidthFor('activity-child', 2)).toBe(1);
  });

  it('keeps every activity-child leading at the same cell width as the gutter', () => {
    for (const kind of ['activity-child', 'activity-child-last'] as const) {
      expect(rowLeadingCells(kind)).toBe(3);
    }
    expect(rowLeading('activity-child')).toBe(` ${glyph('treeBranch')} `);
    expect(rowLeading('activity-child-last')).toBe(` ${glyph('treeLast')} `);
    expect(rowLeading('activity-more')).toBe('   ');
    expect(rowLeadingCells('activity-more')).toBe(3);
    expect(rowLeadingCells('activity')).toBe(3);
  });

  it('emits status-specific header glyphs at a byte-stable width-3 prefix', () => {
    for (const kind of ['activity', 'task-header'] as const) {
      expect(rowLeading(kind)).toBe(` ${glyph('statusInProgress')} `);
      expect(rowLeading(kind, 'live')).toBe(` ${glyph('statusInProgress')} `);
      expect(rowLeading(kind, 'queued')).toBe(` ${glyph('statusPending')} `);
      for (const status of ['live', 'done', 'queued'] as const) {
        expect(getTerminalCellWidth(rowLeading(kind, status))).toBe(3);
      }
    }
    expect(rowLeading('activity', 'done')).toBe(` ${glyph('stageDone')} `);
    expect(rowLeading('task-header', 'done')).toBe(` ${glyph('statusDone')} `);
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

  it('puts every kind of content on column 3, marked or not', () => {
    const kinds: ConversationRowKind[] = [
      'message',
      'prompt',
      'card',
      'card-top',
      'card-body',
      'card-bottom',
      'callout-top',
      'callout-body',
      'activity',
      'activity-child',
      'activity-child-last',
      'activity-more',
      'task-header',
      'diff-header',
      'diff-line',
      'spacer',
      'section',
      'summary',
    ];
    for (const kind of kinds) {
      expect(rowLeadingCells(kind)).toBe(3);
      for (const status of ['live', 'done', 'queued'] as const) {
        const leading = rowLeading(kind, status);
        // Cell 0 is the hover bar's, cell 1 is the mark's — blank on an unmarked row, never a
        // letter — and cell 2 is the mark's trailing space.
        expect(leading.startsWith(' ')).toBe(true);
        expect(leading.at(2)).toBe(' ');
        expect(getTerminalCellWidth(leading)).toBe(3);
      }
    }
  });
});
