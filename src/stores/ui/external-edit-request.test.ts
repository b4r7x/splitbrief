import { afterEach, describe, expect, it } from 'vitest';
import { externalEditRequestStore } from './external-edit-request.js';

describe('externalEditRequestStore', () => {
  afterEach(() => {
    externalEditRequestStore.reset();
  });

  it('request publishes owner token; consume returns to idle', () => {
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });

    externalEditRequestStore.request(7);
    expect(externalEditRequestStore.get()).toEqual({ status: 'requested', ownerToken: 7 });

    externalEditRequestStore.consume();
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });
});
