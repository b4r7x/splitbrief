import { createStore, storeBase } from '../create-store.js';
import { createDraftDocument } from '../../core/composer/document.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { draftDocumentText } from './input-history.js';

interface ComposerDraftDocumentRequest {
  /**
   * A `command` stands in front of the draft rather than in its place: the draft comes back once
   * the box is empty again. A `prepend` goes in front of the draft, joined on a new line.
   */
  kind: 'document' | 'command' | 'prepend';
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

function requestDocument(
  kind: ComposerDraftDocumentRequest['kind'],
  document: DraftDocument,
): void {
  store.set((s) => ({
    request: {
      kind,
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
  request: (value: string) => requestDocument('document', createDraftDocument(value)),
  requestCommand: (value: string) => requestDocument('command', createDraftDocument(value)),
  requestDocument: (document: DraftDocument) => requestDocument('document', document),
  /** A refused send comes back in front of what the composer holds now, so neither is lost. */
  requestPrepend: (document: DraftDocument) => requestDocument('prepend', document),
  requestImage,
  clear: () => store.set((s) => (s.request === null ? s : { request: null })),
};
