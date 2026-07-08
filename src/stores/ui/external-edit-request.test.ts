import { afterEach, describe, expect, it } from 'vitest';
import { externalEditRequestStore } from './external-edit-request.js';

describe('externalEditRequestStore', () => {
  afterEach(() => {
    externalEditRequestStore.reset();
  });

  it('requests with a token, exposes it via a selector, and consumes back to idle', () => {
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });

    externalEditRequestStore.request(7);
    expect(externalEditRequestStore.get()).toEqual({ status: 'requested', ownerToken: 7 });

    const snapshot = externalEditRequestStore.get();
    const token = snapshot.status === 'requested' ? snapshot.ownerToken : null;
    expect(token).toBe(7);

    externalEditRequestStore.consume();
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });
});
