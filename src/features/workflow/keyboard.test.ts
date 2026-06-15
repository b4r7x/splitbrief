import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { handleConversationScroll, handleReviewScroll } from './keyboard.js';

describe('handleConversationScroll', () => {
  const base = {
    key: {} as Key,
    renderableCount: 24,
    maxOffset: 9,
    viewportHeight: 12,
    totalHeight: 42,
  };

  it('maps Home to the top and End to the bottom conversation scroll actions', () => {
    expect(handleConversationScroll({ ...base, key: { home: true } as Key })).toEqual({
      type: 'conversation-scroll-up',
      renderableCount: 24,
      step: 9,
      totalHeight: 42,
      maxOffset: 9,
    });
    expect(handleConversationScroll({ ...base, key: { end: true } as Key })).toEqual({
      type: 'conversation-scroll-bottom',
      renderableCount: 24,
    });
  });

  it('ignores the plain printable g and G keys so they reach the composer as text', () => {
    expect(handleConversationScroll({ ...base, key: { home: false } as Key })).toEqual({
      type: 'none',
    });
    expect(handleConversationScroll({ ...base, key: { end: false } as Key })).toEqual({
      type: 'none',
    });
  });

  it('does not scroll on plain arrows but does on the advertised Shift+arrow and PgUp/PgDn keys', () => {
    expect(handleConversationScroll({ ...base, key: { upArrow: true } as Key })).toEqual({
      type: 'none',
    });
    expect(handleConversationScroll({ ...base, key: { downArrow: true } as Key })).toEqual({
      type: 'none',
    });

    expect(
      handleConversationScroll({ ...base, key: { shift: true, upArrow: true } as Key }).type,
    ).toBe('conversation-scroll-up');
    expect(
      handleConversationScroll({ ...base, key: { shift: true, downArrow: true } as Key }).type,
    ).toBe('conversation-scroll-down');
    expect(handleConversationScroll({ ...base, key: { pageUp: true } as Key }).type).toBe(
      'conversation-scroll-up',
    );
    expect(handleConversationScroll({ ...base, key: { pageDown: true } as Key }).type).toBe(
      'conversation-scroll-down',
    );
  });
});

describe('handleReviewScroll', () => {
  const base = {
    key: {} as Key,
    reviewScrollOffset: 0,
    reviewLineCount: 40,
    visibleHeight: 10,
  };

  it('maps End to the bottom of the review and ignores the plain printable G key', () => {
    expect(handleReviewScroll({ ...base, key: { end: true } as Key })).toEqual({
      type: 'review-scroll',
      offset: 30,
    });
    expect(handleReviewScroll({ ...base, key: { end: false } as Key })).toEqual({
      type: 'none',
    });
  });
});
