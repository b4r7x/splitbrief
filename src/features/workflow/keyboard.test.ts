import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { handleConversationScroll } from './keyboard.js';

describe('handleConversationScroll', () => {
  const base = {
    key: {} as Key,
    renderableCount: 24,
    maxOffset: 9,
    viewportHeight: 12,
    totalHeight: 42,
  };

  it('maps g to the top and G to the bottom conversation scroll actions', () => {
    expect(handleConversationScroll({ ...base, input: 'g' })).toEqual({
      type: 'conversation-scroll-up',
      renderableCount: 24,
      step: 9,
      totalHeight: 42,
      maxOffset: 9,
    });
    expect(handleConversationScroll({ ...base, input: 'G' })).toEqual({
      type: 'conversation-scroll-bottom',
      renderableCount: 24,
    });
  });
});
