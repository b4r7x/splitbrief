import { createStore, storeBase } from '../create-store.js';
import { createDraftDocument } from '../../core/composer/document.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { draftDocumentText } from './input-history.js';

interface ComposerDraftDocumentRequest {
  kind: 'document';
  epoch: number;
  value: string;
  document: DraftDocument;
}

interface ComposerDraftImageRequest {
  kind: 'image';
  epoch: number;
  value: '';
  attachment: Attachment;
}

export type ComposerDraftRequest = ComposerDraftDocumentRequest | ComposerDraftImageRequest;

const store = createStore<{ request: ComposerDraftRequest | null }>({ request: null });

function requestDocument(document: DraftDocument): void {
  store.set((s) => ({
    request: {
      kind: 'document',
      epoch: (s.request?.epoch ?? 0) + 1,
      value: draftDocumentText(document),
      document,
    },
  }));
}

function requestImage(attachment: Attachment): void {
  store.set((s) => ({
    request: {
      kind: 'image',
      epoch: (s.request?.epoch ?? 0) + 1,
      value: '',
      attachment: { ...attachment },
    },
  }));
}

export const composerDraftStore = {
  ...storeBase(store),
  request: (value: string) => requestDocument(createDraftDocument(value)),
  requestDocument,
  requestImage,
  clear: () => store.set((s) => (s.request === null ? s : { request: null })),
};
