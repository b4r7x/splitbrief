import { createStore, storeBase } from '../create.js';
import { createDraftDocument } from '../../core/composer/document.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { draftDocumentText } from './input-history.js';

type DraftUpdate = { document: DraftDocument } & (
  | { kind: 'document' | 'command' }
  | { kind: 'prepend'; afterCommit?: (() => void) | undefined }
);

type ComposerDraftDocumentRequest = DraftUpdate & {
  epoch: number;
  value: string;
};

interface ComposerDraftImageRequest {
  kind: 'image';
  epoch: number;
  value: '';
  attachment: Attachment;
}

export type ComposerDraftRequest = ComposerDraftDocumentRequest | ComposerDraftImageRequest;

const store = createStore<{ request: ComposerDraftRequest | null }>({ request: null });

function requestDocument(update: DraftUpdate): void {
  store.set((s) => ({
    request: {
      ...update,
      epoch: (s.request?.epoch ?? 0) + 1,
      value: draftDocumentText(update.document),
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
  request: (value: string) =>
    requestDocument({ kind: 'document', document: createDraftDocument(value) }),
  requestCommand: (value: string) =>
    requestDocument({ kind: 'command', document: createDraftDocument(value) }),
  requestDocument: (document: DraftDocument) => requestDocument({ kind: 'document', document }),
  /** A refused send comes back in front of what the composer holds now, so neither is lost. */
  requestPrepend: (document: DraftDocument, afterCommit?: () => void) =>
    requestDocument({ kind: 'prepend', document, afterCommit }),
  requestImage,
  clear: () => store.set((s) => (s.request === null ? s : { request: null })),
};
