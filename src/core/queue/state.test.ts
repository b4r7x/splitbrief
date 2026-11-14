import { describe, expect, it } from 'vitest';
import { makeMessage } from '#testing/helpers/queue.js';
import {
  isQueuedMessageClearable,
  isQueuedMessagePendingDelivery,
  isQueuedMessagePendingFirstDelivery,
  isQueuedMessagePendingReviewer,
  messageSeat,
} from './state.js';

describe('messageSeat', () => {
  it('names no seat while REVIEW None checks the merged result again: no seat reads a message', () => {
    expect(messageSeat('final-review', false, true, false)).toBeNull();
    expect(messageSeat('final-review', false, false, false)).toBe('review');
    expect(messageSeat('implementing', false, true, true)).toBe('build');
  });

  it('names no review seat for a task review that a move to REVIEW None left pending', () => {
    expect(messageSeat('implementing', true, true, true)).toBe('build');
    expect(messageSeat('final-review', true, true, false)).toBeNull();
  });

  it('names REVIEW for a due task review of a run with a review seat while a brief is left', () => {
    expect(messageSeat('implementing', true, false, true)).toBe('review');
  });

  it.each([true, false])(
    'names no seat under REVIEW None when no brief is left (task review due: %s)',
    (reviewing) => {
      expect(messageSeat('implementing', reviewing, true, false)).toBeNull();
    },
  );

  it('needs no brief left for PLAN, or for a run with a review seat', () => {
    expect(messageSeat('planning', false, true, false)).toBe('plan');
    expect(messageSeat('implementing', false, false, false)).toBe('build');
    expect(messageSeat('implementing', true, false, false)).toBe('review');
  });
});

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
