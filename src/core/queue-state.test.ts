import { describe, expect, it } from 'vitest';
import { makeMessage } from '#testing/helpers/queue.js';
import {
  isQueuedMessageClearable,
  isQueuedMessagePendingDelivery,
  isQueuedMessagePendingFirstDelivery,
  isQueuedMessagePendingReviewer,
} from './queue-state.js';

describe('mid-call queue state', () => {
  it('keeps reviewer-read messages for BUILD without counting or clearing their history', () => {
    const message = makeMessage();
    expect(isQueuedMessagePendingDelivery(message)).toBe(true);
    expect(isQueuedMessagePendingReviewer(message)).toBe(true);
    expect(isQueuedMessageClearable(message)).toBe(true);
    expect(isQueuedMessagePendingFirstDelivery(message)).toBe(true);
    const delivered = {
      ...message,
      deliveredMidCall: true as const,
      deliveredTo: { reviewer: new Date().toISOString() },
    };
    expect(isQueuedMessagePendingDelivery(delivered)).toBe(true);
    expect(isQueuedMessagePendingReviewer(delivered)).toBe(false);
    expect(isQueuedMessageClearable(delivered)).toBe(false);
    expect(isQueuedMessagePendingFirstDelivery(delivered)).toBe(false);
    const built = {
      ...delivered,
      drainedAt: new Date().toISOString(),
      deliveredTo: { ...delivered.deliveredTo, implementer: new Date().toISOString() },
    };
    expect(isQueuedMessagePendingDelivery(built)).toBe(false);
    expect(isQueuedMessageClearable(built)).toBe(false);
  });

  it('counts an unacknowledged native injection until its first delivery', () => {
    const injecting = { ...makeMessage(), nativeDeliveryState: 'injecting' as const };
    expect(isQueuedMessagePendingFirstDelivery(injecting)).toBe(true);
    expect(isQueuedMessageClearable(injecting)).toBe(true);
    expect(
      isQueuedMessagePendingFirstDelivery({ ...injecting, nativeDeliveryState: 'delivered' }),
    ).toBe(false);
  });
});
