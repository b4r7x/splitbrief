import { beforeEach, describe, expect, it } from 'vitest';
import { createDraftDocument } from '../../core/composer/document.js';
import { composerLiveStore } from './composer-live.js';

describe('composerLiveStore', () => {
  beforeEach(() => {
    composerLiveStore.reset();
  });

  it('starts empty and follows the composer draft', () => {
    expect(composerLiveStore.get()).toEqual({ empty: true, text: '' });
    composerLiveStore.setDraft(createDraftDocument('add a default'));
    expect(composerLiveStore.get()).toEqual({ empty: false, text: 'add a default' });
  });

  it('keeps the same snapshot when the draft does not change', () => {
    composerLiveStore.setDraft(createDraftDocument('x'));
    const first = composerLiveStore.get();
    composerLiveStore.setDraft(createDraftDocument('x'));
    expect(composerLiveStore.get()).toBe(first);
  });
});
