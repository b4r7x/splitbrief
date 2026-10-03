import { afterEach, describe, expect, it } from 'vitest';
import { externalEditRequestStore } from './external-edit-request.js';

describe('externalEditRequestStore', () => {
  afterEach(() => {
    externalEditRequestStore.reset();
  });

  it('request publishes owner token and the text the edit started from; consume returns to idle', () => {
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });

    externalEditRequestStore.request(7, '{}\n');
    expect(externalEditRequestStore.get()).toEqual({
      status: 'requested',
      ownerToken: 7,
      action: 'open-external',
      baseline: '{}\n',
    });

    externalEditRequestStore.consume();
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });

  it('requestApply asks the review prompt to settle the gate with a saved edit', () => {
    externalEditRequestStore.requestApply(3);
    expect(externalEditRequestStore.get()).toEqual({
      status: 'requested',
      ownerToken: 3,
      action: 'apply-edit',
    });
  });
});
