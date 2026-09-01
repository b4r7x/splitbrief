import { describe, expect, it } from 'vitest';
import { clearSessionScopedStores } from './session-stores.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { reviewStore } from '../../stores/workflow/review.js';

describe('clearSessionScopedStores', () => {
  it('resets the lifecycle, conversation scroll and review stores', () => {
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 7, phase: 'final-review' });
    conversationScrollStore.__testReset({ scrollOffset: 12 });
    reviewStore.setReviewFile('spec.md');

    clearSessionScopedStores();

    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    expect(reviewStore.get().source).toBeNull();
  });
});
