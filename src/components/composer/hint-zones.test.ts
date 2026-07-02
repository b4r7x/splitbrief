import { describe, expect, it } from 'vitest';
import {
  compactComposerHints,
  composerHintSegments,
  composerHintZoneRects,
  computeComposerHintBudget,
  renderComposerHint,
} from './hint-zones.js';

describe('composer in-box hint hotspots', () => {
  it('budget shrinks linearly with box width', () => {
    expect(computeComposerHintBudget({ boxWidth: 80 })).toBe(48);
    expect(computeComposerHintBudget({ boxWidth: 45 })).toBe(13);
    expect(computeComposerHintBudget({ boxWidth: 40 })).toBe(8);
    expect(computeComposerHintBudget({ boxWidth: 10 })).toBe(0);
  });

  it('compacts the hint ladder: full → drop cost', () => {
    const hints = { keys: 'Ctrl+D detach', cost: '$0.03' };

    expect(compactComposerHints(hints, 20)).toEqual({ keys: 'Ctrl+D detach', cost: '$0.03' });
    expect(compactComposerHints(hints, 19)).toEqual({ keys: 'Ctrl+D detach', cost: undefined });
  });

  it('renders the right-aligned hint with the cost trailing the keys', () => {
    expect(renderComposerHint({ keys: 'Ctrl+D detach', cost: '$0.03' })).toBe(
      'Ctrl+D detach  $0.03',
    );
    expect(renderComposerHint({ keys: '', cost: '$0.03' })).toBe('$0.03');
    expect(renderComposerHint({ keys: 'Ctrl+D detach', cost: undefined })).toBe('Ctrl+D detach');
  });

  it('maps the cost token to its cell offset after the keys', () => {
    expect(composerHintSegments({ keys: 'Ctrl+D detach', cost: '$0.03' })).toEqual([
      { id: 'cost', offset: 15, width: 5 },
    ]);
  });

  it('drops the cost zone when the cost is compacted away (no phantom hotspot)', () => {
    expect(composerHintSegments({ keys: 'Ctrl+D detach', cost: undefined })).toEqual([]);
  });

  it('measures segment offsets in cells so a wide-cell glyph cannot drift a zone', () => {
    // '混' is a width-2 CJK glyph but a single JS code unit; a raw character index would place the
    // cost segment one cell too far left. Offsets must be the cell width of the prefix.
    const rendered = renderComposerHint({ keys: '混 key', cost: '$0.03' });
    expect(rendered).toBe('混 key  $0.03');
    expect(composerHintSegments({ keys: '混 key', cost: '$0.03' })).toEqual([
      { id: 'cost', offset: 8, width: 5 },
    ]);
  });

  it('calibrates zone rects to the right edge of the box on the hint row', () => {
    const rects = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 80,
      hintRow: 22,
      display: { keys: 'Ctrl+D detach', cost: '$0.03' },
    });

    expect(rects).toEqual([{ id: 'cost', left: 74, right: 78, top: 22, bottom: 22 }]);
    // the cost token ends at the last in-box cell: boxLeft + boxWidth - 3 (1 border + 1 padding).
    expect(rects[0]?.right).toBe(1 + 80 - 3);
    // calibration: a click on the hint row maps to row index 0 (sgrY - rect.top).
    expect(22 - (rects[0]?.top ?? 0)).toBe(0);
  });

  it('reclaims the padding cells and shifts zones right for a flush (paddingX=0) box', () => {
    // The flush workflow composer drops both padding columns, so the hint budget widens by two and
    // every zone slides one cell toward the border.
    expect(computeComposerHintBudget({ boxWidth: 80, paddingX: 0 })).toBe(
      computeComposerHintBudget({ boxWidth: 80 }) + 2,
    );

    const rects = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 80,
      hintRow: 22,
      display: { keys: 'Ctrl+D detach', cost: '$0.03' },
      paddingX: 0,
    });

    expect(rects).toEqual([{ id: 'cost', left: 75, right: 79, top: 22, bottom: 22 }]);
    // With no padding the cost token ends at the last in-box cell: boxLeft + boxWidth - 2 (border only).
    expect(rects[0]?.right).toBe(1 + 80 - 2);
  });

  it('tracks the compacted render so a dropped hint is never clickable', () => {
    const narrow = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 52,
      hintRow: 22,
      display: compactComposerHints(
        { keys: 'Ctrl+D detach', cost: '$0.03' },
        computeComposerHintBudget({ boxWidth: 52 }),
      ),
    });

    expect(narrow.map((rect) => rect.id)).toEqual(['cost']);
    expect(narrow.some((rect) => rect.id === 'cost')).toBe(true);

    const veryNarrow = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 45,
      hintRow: 22,
      display: compactComposerHints(
        { keys: 'Ctrl+D detach', cost: '$0.03' },
        computeComposerHintBudget({ boxWidth: 45 }),
      ),
    });

    expect(veryNarrow).toEqual([]);
  });
});
