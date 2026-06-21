import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import type { Section } from '../../core/sections/event-sections.js';
import type { EngineEvent } from '../../engine/events/types.js';
import {
  handleConversationScroll,
  handleReviewScroll,
  handleWorkflowCtrlChords,
} from './keyboard.js';

const sections: Section<EngineEvent>[] = [];

function key(overrides: Partial<Key>): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

describe('handleConversationScroll', () => {
  const base = {
    input: '',
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

  it('maps Ctrl+B and Ctrl+F to page conversation scroll actions', () => {
    expect(handleConversationScroll({ ...base, input: 'b', key: { ctrl: true } as Key })).toEqual({
      type: 'conversation-scroll-up',
      renderableCount: 24,
      step: 10,
      totalHeight: 42,
      maxOffset: 9,
    });
    expect(handleConversationScroll({ ...base, input: 'f', key: { ctrl: true } as Key })).toEqual({
      type: 'conversation-scroll-down',
      step: 10,
    });
  });
});

describe('handleReviewScroll', () => {
  const base = {
    input: '',
    key: {} as Key,
    reviewScrollOffset: 0,
    reviewLineCount: 40,
    visibleHeight: 10,
  };

  it('maps Shift+arrows to line review scroll actions and ignores plain arrows', () => {
    expect(handleReviewScroll({ ...base, key: { shift: true, downArrow: true } as Key })).toEqual({
      type: 'review-scroll',
      offset: 1,
    });
    expect(
      handleReviewScroll({
        ...base,
        key: { shift: true, upArrow: true } as Key,
        reviewScrollOffset: 1,
      }),
    ).toEqual({
      type: 'review-scroll',
      offset: 0,
    });
    expect(handleReviewScroll({ ...base, key: { downArrow: true } as Key })).toEqual({
      type: 'none',
    });
    expect(handleReviewScroll({ ...base, key: { upArrow: true } as Key })).toEqual({
      type: 'none',
    });
  });

  it('maps Home, PageUp, PageDown, and End to review scroll actions', () => {
    expect(
      handleReviewScroll({ ...base, key: { home: true } as Key, reviewScrollOffset: 20 }),
    ).toEqual({
      type: 'review-scroll',
      offset: 0,
    });
    expect(
      handleReviewScroll({ ...base, key: { pageUp: true } as Key, reviewScrollOffset: 20 }),
    ).toEqual({
      type: 'review-scroll',
      offset: 10,
    });
    expect(
      handleReviewScroll({ ...base, key: { pageDown: true } as Key, reviewScrollOffset: 20 }),
    ).toEqual({
      type: 'review-scroll',
      offset: 30,
    });
    expect(handleReviewScroll({ ...base, key: { end: true } as Key })).toEqual({
      type: 'review-scroll',
      offset: 30,
    });
  });

  it('maps Ctrl+B and Ctrl+F to page review scroll actions', () => {
    expect(
      handleReviewScroll({
        ...base,
        input: 'b',
        key: { ctrl: true } as Key,
        reviewScrollOffset: 20,
      }),
    ).toEqual({
      type: 'review-scroll',
      offset: 10,
    });
    expect(
      handleReviewScroll({
        ...base,
        input: 'f',
        key: { ctrl: true } as Key,
        reviewScrollOffset: 20,
      }),
    ).toEqual({
      type: 'review-scroll',
      offset: 30,
    });
  });

  it('ignores the plain printable G key', () => {
    expect(handleReviewScroll({ ...base, key: { end: false } as Key })).toEqual({
      type: 'none',
    });
  });
});

describe('handleWorkflowCtrlChords', () => {
  it('maps Alt/Meta+A to the latest expandable activity batch', () => {
    expect(
      handleWorkflowCtrlChords({
        input: 'a',
        key: key({ meta: true }),
        isSmall: false,
        sections,
        findLatestDiff: () => null,
        findLatestActivityBatch: () => 'activity-batch:0:call-1',
      }),
    ).toEqual({ type: 'toggle-activity-batch', key: 'activity-batch:0:call-1' });
  });

  it('leaves Ctrl+A for composer line-start editing', () => {
    expect(
      handleWorkflowCtrlChords({
        input: 'a',
        key: key({ ctrl: true }),
        isSmall: false,
        sections,
        findLatestDiff: () => null,
        findLatestActivityBatch: () => 'activity-batch:0:call-1',
      }),
    ).toEqual({ type: 'none' });
  });

  it('ignores plain a and A so they reach the composer as text', () => {
    for (const input of ['a', 'A']) {
      expect(
        handleWorkflowCtrlChords({
          input,
          key: key({}),
          isSmall: false,
          sections,
          findLatestDiff: () => null,
          findLatestActivityBatch: () => 'activity-batch:0:call-1',
        }),
      ).toEqual({ type: 'none' });
    }
  });
});
