import { afterEach, describe, expect, it } from 'vitest';
import { createDraftDocument } from '../../core/composer/document.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { getInputHistoryDocuments, inputHistoryStore } from '../../stores/ui/input-history.js';
import {
  INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE,
  INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
  stepDocumentHistory,
  stepInputHistory,
} from './history.js';

describe('stepInputHistory', () => {
  it('does nothing when there is no history', () => {
    const result = stepInputHistory({
      entries: [],
      state: INITIAL_INPUT_HISTORY_NAVIGATION_STATE,
      direction: 'up',
      currentValue: 'draft',
    });

    expect(result.changed).toBe(false);
    expect(result.nextValue).toBe('draft');
    expect(result.nextState).toEqual(INITIAL_INPUT_HISTORY_NAVIGATION_STATE);
  });

  it('round-trips every Up/Down transition, capturing and restoring the draft', () => {
    const entries = ['third', 'second', 'first'];
    let state = INITIAL_INPUT_HISTORY_NAVIGATION_STATE;
    let value = 'draft';

    const up1 = stepInputHistory({ entries, state, direction: 'up', currentValue: value });
    expect(up1.changed).toBe(true);
    expect(up1.nextValue).toBe('third');
    expect(up1.nextState).toEqual({ historyIndex: 0, draftValue: 'draft' });
    state = up1.nextState;
    value = up1.nextValue;

    const up2 = stepInputHistory({ entries, state, direction: 'up', currentValue: value });
    expect(up2.changed).toBe(true);
    expect(up2.nextValue).toBe('second');
    expect(up2.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
    state = up2.nextState;
    value = up2.nextValue;

    const up3 = stepInputHistory({ entries, state, direction: 'up', currentValue: value });
    expect(up3.changed).toBe(true);
    expect(up3.nextValue).toBe('first');
    expect(up3.nextState).toEqual({ historyIndex: 2, draftValue: 'draft' });
    state = up3.nextState;
    value = up3.nextValue;

    const down1 = stepInputHistory({ entries, state, direction: 'down', currentValue: value });
    expect(down1.changed).toBe(true);
    expect(down1.nextValue).toBe('second');
    expect(down1.nextState).toEqual({ historyIndex: 1, draftValue: 'draft' });
    state = down1.nextState;
    value = down1.nextValue;

    const down2 = stepInputHistory({ entries, state, direction: 'down', currentValue: value });
    expect(down2.changed).toBe(true);
    expect(down2.nextValue).toBe('third');
    expect(down2.nextState).toEqual({ historyIndex: 0, draftValue: 'draft' });
    state = down2.nextState;
    value = down2.nextValue;

    const down3 = stepInputHistory({ entries, state, direction: 'down', currentValue: value });
    expect(down3.changed).toBe(true);
    expect(down3.nextValue).toBe('draft');
    expect(down3.nextState).toEqual({ historyIndex: null, draftValue: 'draft' });
  });
});

describe('stepDocumentHistory', () => {
  afterEach(() => {
    inputHistoryStore.reset();
    composerDraftStore.reset();
  });

  const screenshot = {
    id: 'img-1',
    kind: 'image' as const,
    path: '/tmp/screenshot.png',
    mimeType: 'image/png',
    sizeBytes: 4,
  };

  it('round-trips a document with an image between text and restores the pending draft', () => {
    const withImage: DraftDocument = {
      version: 1,
      parts: [
        { kind: 'text', text: 'before\n' },
        { kind: 'image', attachment: screenshot },
        { kind: 'text', text: '\nafter' },
      ],
    };
    const older = createDraftDocument('older prompt');
    const pending = createDraftDocument('half-typed\nsecond line');
    inputHistoryStore.pushDocumentSubmission(older, { currentScreen: 'home' });
    inputHistoryStore.pushDocumentSubmission(withImage, { currentScreen: 'home' });
    const entries = getInputHistoryDocuments(inputHistoryStore.get(), { currentScreen: 'home' });

    const up1 = stepDocumentHistory({
      entries,
      state: INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE,
      direction: 'up',
      currentValue: pending,
    });
    expect(up1.nextValue).toEqual(withImage);

    const up2 = stepDocumentHistory({
      entries,
      state: up1.nextState,
      direction: 'up',
      currentValue: up1.nextValue,
    });
    expect(up2.nextValue).toEqual(older);

    const down1 = stepDocumentHistory({
      entries,
      state: up2.nextState,
      direction: 'down',
      currentValue: up2.nextValue,
    });
    expect(down1.nextValue).toEqual(withImage);

    const down2 = stepDocumentHistory({
      entries,
      state: down1.nextState,
      direction: 'down',
      currentValue: down1.nextValue,
    });
    expect(down2.changed).toBe(true);
    expect(down2.nextValue).toEqual(pending);
    expect(down2.nextState).toEqual({ historyIndex: null, draftValue: pending });
  });

  it('recalls a folded paste from the store alone after the composer state is gone', () => {
    const paste = 'line 1\nline 2\nline 3\nline 4';
    inputHistoryStore.pushDocumentSubmission(createDraftDocument(paste), {
      currentScreen: 'home',
    });

    const remounted = stepDocumentHistory({
      entries: getInputHistoryDocuments(inputHistoryStore.get(), { currentScreen: 'home' }),
      state: INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE,
      direction: 'up',
      currentValue: INITIAL_DOCUMENT_HISTORY_NAVIGATION_STATE.draftValue,
    });

    expect(remounted.nextValue).toEqual({ version: 1, parts: [{ kind: 'text', text: paste }] });

    composerDraftStore.requestDocument(remounted.nextValue);
    expect(composerDraftStore.get().request).toMatchObject({
      value: paste,
      document: remounted.nextValue,
    });
  });
});
