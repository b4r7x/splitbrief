import { describe, expect, it } from 'vitest';
import {
  resolveScrollKey,
  stepForScrollAction,
  type ScrollKeyAction,
  type ScrollKeyLike,
  type ScrollLineKeyMode,
} from './scroll.js';

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

describe('stepForScrollAction', () => {
  const actions: ScrollKeyAction[] = [
    'line-up',
    'line-down',
    'page-up',
    'page-down',
    'top',
    'bottom',
  ];

  it.each([
    ['in the middle', { position: 10, page: 5, last: 20 }, [9, 11, 5, 15, 0, 20]],
    ['at the start', { position: 0, page: 5, last: 20 }, [0, 1, 0, 5, 0, 20]],
    ['at the end', { position: 20, page: 5, last: 20 }, [19, 20, 15, 20, 0, 20]],
    [
      'with a page longer than the document',
      { position: 1, page: 10, last: 3 },
      [0, 2, 0, 3, 0, 3],
    ],
  ])('keeps each step %s between the first and the last position', (_, at, expected) => {
    expect(actions.map((action) => stepForScrollAction({ action, ...at }))).toEqual(expected);
  });
});
