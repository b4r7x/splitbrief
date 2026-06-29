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
    expect(computeComposerHintBudget(80)).toBe(48);
    expect(computeComposerHintBudget(45)).toBe(13);
    expect(computeComposerHintBudget(40)).toBe(8);
    expect(computeComposerHintBudget(10)).toBe(0);
  });

  it('compacts the hint ladder: full → drop cost', () => {
    const hints = { keys: '⏎', cost: '$0.03' };

    expect(compactComposerHints(hints, 8)).toEqual({ keys: '⏎', cost: '$0.03' });
    expect(compactComposerHints(hints, 7)).toEqual({ keys: '⏎', cost: undefined });
  });

  it('renders the right-aligned hint with the cost trailing the keys', () => {
    expect(renderComposerHint({ keys: 'tab  ⏎', cost: '$0.03' })).toBe('tab  ⏎  $0.03');
    expect(renderComposerHint({ keys: '', cost: '$0.03' })).toBe('$0.03');
    expect(renderComposerHint({ keys: '⏎', cost: undefined })).toBe('⏎');
  });

  it('maps the submit glyph and cost token to their cell offsets', () => {
    expect(composerHintSegments({ keys: 'tab  ⏎', cost: '$0.03' })).toEqual([
      { id: 'submit', offset: 5, width: 1 },
      { id: 'cost', offset: 8, width: 5 },
    ]);
  });

  it('drops the cost zone when the cost is compacted away (no phantom hotspot)', () => {
    expect(composerHintSegments({ keys: '⏎', cost: undefined })).toEqual([
      { id: 'submit', offset: 0, width: 1 },
    ]);
  });

  it('measures segment offsets in cells so a wide-cell glyph cannot drift a zone', () => {
    // '混' is a width-2 CJK glyph but a single JS code unit; a raw character index would place the
    // submit/cost segments one cell too far left. Offsets must be the cell width of the prefix.
    const rendered = renderComposerHint({ keys: '混 ⏎', cost: '$0.03' });
    expect(rendered).toBe('混 ⏎  $0.03');
    expect(composerHintSegments({ keys: '混 ⏎', cost: '$0.03' })).toEqual([
      { id: 'submit', offset: 3, width: 1 },
      { id: 'cost', offset: 6, width: 5 },
    ]);
  });

  it('calibrates zone rects to the right edge of the box on the hint row', () => {
    const rects = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 80,
      hintRow: 22,
      display: { keys: 'tab  ⏎', cost: '$0.03' },
    });

    expect(rects).toEqual([
      { id: 'submit', left: 71, right: 71, top: 22, bottom: 22 },
      { id: 'cost', left: 74, right: 78, top: 22, bottom: 22 },
    ]);
    // the cost token ends at the last in-box cell: boxLeft + boxWidth - 3 (1 border + 1 padding).
    expect(rects[1]?.right).toBe(1 + 80 - 3);
    // calibration: a click on the hint row maps to row index 0 (sgrY - rect.top).
    expect(22 - (rects[0]?.top ?? 0)).toBe(0);
  });

  it('tracks the compacted render so a dropped hint is never clickable', () => {
    const narrow = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 40,
      hintRow: 22,
      display: compactComposerHints({ keys: '⏎', cost: '$0.03' }, computeComposerHintBudget(40)),
    });

    expect(narrow.map((rect) => rect.id)).toEqual(['submit', 'cost']);
    expect(narrow.some((rect) => rect.id === 'cost')).toBe(true);

    const veryNarrow = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 36,
      hintRow: 22,
      display: compactComposerHints({ keys: '⏎', cost: '$0.03' }, computeComposerHintBudget(36)),
    });

    expect(veryNarrow.map((rect) => rect.id)).toEqual(['submit']);
  });
});
