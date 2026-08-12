import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { rowText } from './row-format/rows.js';
import type { ConversationRow, ConversationRowSegment } from './types.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function implementerDoneEvent(
  overrides: Partial<EngineEventOf<'implementer_generate_done'>> = {},
): EngineEventOf<'implementer_generate_done'> {
  return {
    type: 'implementer_generate_done',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    file: 'README.md',
    diff: '+ added line\n- removed line',
    linesAdded: 1,
    linesRemoved: 1,
    duration: 1234,
    ...overrides,
  };
}

function rowsFor(
  event: EngineEventOf<'implementer_generate_done'>,
  expanded: boolean,
  width = 80,
): ConversationRow[] {
  return eventRows({
    event,
    globalIndex: 0,
    expanded,
    ctx: { width, viewportRows: 24, streaming },
  });
}

function requireRow(
  rows: ConversationRow[],
  matcher: (row: ConversationRow) => boolean,
): ConversationRow {
  const found = rows.find(matcher);
  expect(found).toBeDefined();
  if (found === undefined) {
    throw new Error('requireRow: row not found');
  }
  return found;
}

function requireSegment(
  segments: ConversationRowSegment[],
  matcher: (segment: ConversationRowSegment) => boolean,
): ConversationRowSegment {
  const found = segments.find(matcher);
  expect(found).toBeDefined();
  if (found === undefined) {
    throw new Error('requireSegment: segment not found');
  }
  return found;
}

function segmentTone(segment: ConversationRowSegment): string | undefined {
  return segment.tone;
}

describe('implementer_generate_done diff card', () => {
  it('renders expanded diff as a de-boxed file header with +N -M meta', () => {
    const rows = rowsFor(implementerDoneEvent(), true);
    const text = rows.map(rowText).join('\n');

    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-top');
    expect(rowText(topRow)).not.toContain('┌');
    expect(rowText(topRow)).toContain('README.md');
    expect(rowText(topRow)).toContain('+1');
    expect(rowText(topRow)).toContain('-1');
    expect(rowText(topRow)).toContain('1.2s');

    expect(text).not.toMatch(/[┌┐└┘│]/);
    const lastRow = rows.at(-1);
    expect(lastRow?.kind).toBe('card-body');

    const bodyRows = rows.filter((rowValue) => rowValue.kind === 'card-body');
    expect(bodyRows.length).toBeGreaterThan(0);

    const addedBodyRow = requireRow(bodyRows, (rowValue) =>
      rowText(rowValue).includes('added line'),
    );
    const addedTone = requireSegment(addedBodyRow.segments, (segment) => {
      return segment.text.trim().length > 0;
    });
    expect(segmentTone(addedTone)).toBe('diffAdded');

    const removedBodyRow = requireRow(bodyRows, (rowValue) =>
      rowText(rowValue).includes('removed line'),
    );
    const removedTone = requireSegment(removedBodyRow.segments, (segment) => {
      return segment.text.trim().length > 0;
    });
    expect(segmentTone(removedTone)).toBe('diffRemoved');

    requireRow(bodyRows, (rowValue) => rowText(rowValue).includes('ctrl+d to collapse'));

    expect(text).toContain('+ added line');
    expect(text).toContain('- removed line');
    expect(text).not.toMatch(/\bCtrl\+D\b/);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 80)).toBe(true);
  });

  it('fits expanded diff card header with long file paths and metadata', () => {
    const width = 48;
    const rows = rowsFor(
      implementerDoneEvent({
        file: `src/features/workflow/conversation-rows/${'very/deep/'.repeat(8)}module.ts`,
      }),
      true,
      width,
    );

    const topRow = requireRow(rows, (rowValue) => rowValue.kind === 'card-top');
    expect(rowText(topRow)).toContain('1.2s');
    expect(rowText(topRow)).toContain('+1');
    expect(rowText(topRow)).toContain('-1');
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= width)).toBe(true);
  });

  it('renders collapsed diff flat without a card border (byte-identical to pre-change output)', () => {
    const rows = rowsFor(implementerDoneEvent(), false);
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('README.md (+1 -1)');
    expect(text).toContain('ctrl+d');
    expect(text).not.toContain('▸');
    expect(rows.every((rowValue) => rowValue.kind !== 'card-top')).toBe(true);
    expect(rows.every((rowValue) => rowValue.kind !== 'card-body')).toBe(true);
    expect(rows.every((rowValue) => rowValue.kind !== 'card-bottom')).toBe(true);
    expect(text).not.toContain('┌─');
    expect(text).not.toContain('└');
  });

  it('merges overflow count and collapse hint into one action-hint body line', () => {
    const diff = Array.from({ length: 47 }, (_, index) => `+ line ${index + 1}`).join('\n');
    const rows = rowsFor(implementerDoneEvent({ diff, linesAdded: 47, linesRemoved: 0 }), true);
    const bodyRows = rows.filter((rowValue) => rowValue.kind === 'card-body');
    const text = rows.map(rowText).join('\n');

    const hintRow = requireRow(
      bodyRows,
      (rowValue) =>
        rowText(rowValue).includes('ctrl+d') &&
        rowText(rowValue).includes('more lines') &&
        rowText(rowValue).includes('to collapse'),
    );

    expect(rowText(hintRow)).toContain('…');
    expect(rowText(hintRow)).toContain(' · ');
    expect(text).toContain('to collapse');
    expect(text).not.toMatch(/\bCtrl\+D\b/);
    expect(bodyRows.some((rowValue) => rowText(rowValue).trim() === 'Ctrl+D')).toBe(false);

    const keySegment = requireSegment(hintRow.segments, (segment) =>
      segment.text.includes('to collapse'),
    );
    expect(segmentTone(keySegment)).toBe('textDim');

    const countSegment = requireSegment(hintRow.segments, (segment) =>
      segment.text.includes('more lines'),
    );
    expect(segmentTone(countSegment)).toBe('textDim');

    const maxVisible = 12;
    const visibleCount = Math.min(diff.split('\n').length, maxVisible);
    expect(bodyRows.length).toBe(visibleCount + 1);
    expect(bodyRows.some((rowValue) => rowText(rowValue).includes('to expand'))).toBe(false);
    expect(bodyRows.every((rowValue) => !rowText(rowValue).includes('Ctrl+D'))).toBe(true);
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= 80)).toBe(true);
  });

  it('keeps the merged overflow hint on a single row at width 48', () => {
    const width = 48;
    const diff = Array.from({ length: 47 }, (_, index) => `+ line ${index + 1}`).join('\n');
    const rows = rowsFor(
      implementerDoneEvent({ diff, linesAdded: 47, linesRemoved: 0 }),
      true,
      width,
    );
    const bodyRows = rows.filter((rowValue) => rowValue.kind === 'card-body');
    const hintRows = bodyRows.filter((rowValue) => rowText(rowValue).includes('to collapse'));

    expect(hintRows).toHaveLength(1);
    const hintRow = hintRows[0];
    expect(hintRow).toBeDefined();
    if (hintRow !== undefined) {
      expect(getTerminalCellWidth(rowText(hintRow))).toBeLessThanOrEqual(width);
    }
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= width)).toBe(true);
  });

  it('keeps a narrow overflow hint readable when it wraps', () => {
    const width = 30;
    const diff = Array.from({ length: 47 }, (_, index) => `+ line ${index + 1}`).join('\n');
    const rows = rowsFor(
      implementerDoneEvent({ diff, linesAdded: 47, linesRemoved: 0 }),
      true,
      width,
    );
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('more lines');
    expect(text).toContain('ctrl+d');
    expect(text).toContain('collapse');
    expect(text).not.toContain('│ … … │');
    expect(rows.every((rowValue) => getTerminalCellWidth(rowText(rowValue)) <= width)).toBe(true);
  });
});
