import { describe, expect, it } from 'vitest';
import { resolveScrollKey, type ScrollKeyLike, type ScrollLineKeyMode } from './scroll.js';

function action(input: {
  text?: string | undefined;
  lineKeys?: ScrollLineKeyMode | undefined;
  key: ScrollKeyLike;
}) {
  return resolveScrollKey({
    input: input.text ?? '',
    key: input.key,
    lineKeys: input.lineKeys ?? 'shifted',
  });
}

describe('resolveScrollKey', () => {
  it('maps physical paging and top-bottom keys', () => {
    expect(action({ key: { pageUp: true } })).toBe('page-up');
    expect(action({ key: { pageDown: true } })).toBe('page-down');
    expect(action({ key: { home: true } })).toBe('top');
    expect(action({ key: { end: true } })).toBe('bottom');
  });

  it('maps Ctrl+B and Ctrl+F as page fallbacks without adding other Ctrl scroll chords', () => {
    expect(action({ text: 'b', key: { ctrl: true } })).toBe('page-up');
    expect(action({ text: 'f', key: { ctrl: true } })).toBe('page-down');

    for (const text of ['a', 'e', 'k', 'u', 'w', 'd', 'q', 'g']) {
      expect(action({ text, key: { ctrl: true } })).toBeNull();
    }
  });

  it('uses shifted arrows for workflow line scroll and ignores plain arrows', () => {
    expect(action({ key: { shift: true, upArrow: true } })).toBe('line-up');
    expect(action({ key: { shift: true, downArrow: true } })).toBe('line-down');
    expect(action({ key: { upArrow: true } })).toBeNull();
    expect(action({ key: { downArrow: true } })).toBeNull();
  });

  it('can use plain arrows for isolated document overlays', () => {
    expect(action({ key: { upArrow: true }, lineKeys: 'plain' })).toBe('line-up');
    expect(action({ key: { downArrow: true }, lineKeys: 'plain' })).toBe('line-down');
    expect(action({ key: { shift: true, downArrow: true }, lineKeys: 'plain' })).toBeNull();
  });
});
