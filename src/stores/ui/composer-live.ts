import { isDeepStrictEqual } from 'node:util';
import { createStore, storeBase } from '../create-store.js';
import { createDraftDocument, draftLength } from '../../core/composer/document.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { draftDocumentText } from './input-history.js';

interface ComposerLiveState {
  empty: boolean;
  /** The typed words of the draft, which a panel action that takes a note sends with it. */
  text: string;
  document: DraftDocument;
}

const initial: ComposerLiveState = { empty: true, text: '', document: createDraftDocument('') };
const store = createStore<ComposerLiveState>(initial);

export const composerLiveStore = {
  ...storeBase(store),
  setDraft: (document: DraftDocument) => {
    const empty = draftLength(document) === 0;
    const text = draftDocumentText(document);
    const current = store.get();
    if (isDeepStrictEqual(current.document, document)) return;
    store.set({ empty, text, document });
  },
};
