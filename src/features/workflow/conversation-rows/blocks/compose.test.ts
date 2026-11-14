import { describe, expect, it } from 'vitest';
import { wrappedSegmentsBlock } from './compose.js';
import { rowText } from '../row-format/rows.js';

describe('wrappedSegmentsBlock', () => {
  it('keeps seat and separator tones while wrapping and windowing once', () => {
    const block = wrappedSegmentsBlock({
      keyPrefix: 'review',
      width: 24,
      kind: 'card',
      segments: [
        { text: 'Reviewer', tone: 'reviewer' },
        { text: ' · ', tone: 'textDim' },
        { text: 'call failed after one repair', tone: 'textDim' },
      ],
    });
    if (block === null) throw new Error('Expected wrapped block');
    const rows = block.createRows(0, block.rowCount);
    expect(rows.flatMap((row) => row.segments)).toContainEqual({
      text: 'Reviewer',
      tone: 'reviewer',
    });
    expect(rows.flatMap((row) => row.segments)).toContainEqual({ text: ' · ', tone: 'textDim' });
    expect(rows.map(rowText).join('')).toBe('Reviewer · call failed after one repair');
    expect(block.createRows(1, block.rowCount)).toEqual(rows.slice(1));
    expect(rows.every((row) => row.kind === 'card')).toBe(true);
  });
});
