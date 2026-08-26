import { afterEach, describe, expect, it } from 'vitest';
import { composerDraftStore } from './composer-draft.js';

describe('composerDraftStore', () => {
  afterEach(() => {
    composerDraftStore.reset();
  });

  it('publishes each requested draft under a strictly increasing epoch', () => {
    expect(composerDraftStore.get().request).toBeNull();

    composerDraftStore.request('/copy ');
    const first = composerDraftStore.get().request;
    expect(first?.value).toBe('/copy ');

    composerDraftStore.request('/copy ');
    const second = composerDraftStore.get().request;
    expect(second?.value).toBe('/copy ');
    expect(second?.epoch).toBeGreaterThan(first?.epoch ?? 0);
  });

  it('clears the pending request', () => {
    composerDraftStore.request('/crew ');
    composerDraftStore.clear();

    expect(composerDraftStore.get().request).toBeNull();
  });

  it('notifies subscribers when a draft is requested', () => {
    let notifications = 0;
    const unsubscribe = composerDraftStore.subscribe(() => {
      notifications += 1;
    });

    composerDraftStore.request('/image ');
    unsubscribe();

    expect(notifications).toBe(1);
  });
});
