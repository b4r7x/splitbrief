import { beforeEach, describe, expect, it } from 'vitest';
import { createDraftDocument } from '../../core/composer/document.js';
import { composerLiveStore } from './composer-live.js';

describe('composerLiveStore', () => {
  beforeEach(() => {
    composerLiveStore.reset();
  });

  it('starts empty and follows the composer draft', () => {
    expect(composerLiveStore.get()).toEqual({
      empty: true,
      text: '',
      document: createDraftDocument(''),
    });
    composerLiveStore.setDraft(createDraftDocument('add a default'));
    expect(composerLiveStore.get()).toEqual({
      empty: false,
      text: 'add a default',
      document: createDraftDocument('add a default'),
    });
  });

  it('keeps the same snapshot when the draft does not change', () => {
    composerLiveStore.setDraft(createDraftDocument('x'));
    const first = composerLiveStore.get();
    composerLiveStore.setDraft(createDraftDocument('x'));
    expect(composerLiveStore.get()).toBe(first);
  });

  it('updates the full document when only image atoms change', () => {
    const document = {
      version: 1 as const,
      parts: [
        {
          kind: 'image' as const,
          attachment: {
            id: 'first',
            kind: 'image' as const,
            path: '/outside/first.png',
            mimeType: 'image/png',
            sizeBytes: 4,
          },
        },
      ],
    };
    composerLiveStore.setDraft(document);
    const first = composerLiveStore.get();
    const next = {
      ...document,
      parts: [
        {
          kind: 'image' as const,
          attachment: {
            ...document.parts[0]?.attachment,
            id: 'second',
            kind: 'image' as const,
            path: '/outside/second.png',
            mimeType: 'image/png',
            sizeBytes: 4,
          },
        },
      ],
    };
    composerLiveStore.setDraft(next);
    expect(composerLiveStore.get()).toEqual({ empty: false, text: '', document: next });
    expect(composerLiveStore.get()).not.toBe(first);
    composerLiveStore.setDraft(structuredClone(next));
    expect(composerLiveStore.get().document).toBe(next);
  });
});
