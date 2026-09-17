import { useEffect, useRef } from 'react';
import { composerDraftStore, type ComposerDraftRequest } from '../../stores/ui/composer-draft.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { useStores } from '../../stores/use-stores.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import type { InputMode } from '../../core/navigation/types.js';
import { assertNever } from '../../utils/type-guards.js';

interface ComposerDraftActions {
  setDocument: (document: DraftDocument) => void;
  insertImage: (attachment: Attachment) => void;
  resetHistory: () => void;
  bumpEpoch: () => void;
}

interface UseDraftSyncParams {
  mode: InputMode;
  questionEpoch: number | undefined;
  actions: ComposerDraftActions;
}

function applyComposerDocument(document: DraftDocument, actions: ComposerDraftActions): void {
  actions.setDocument(document);
  actions.resetHistory();
  actions.bumpEpoch();
}

function applyComposerDraft(request: ComposerDraftRequest, actions: ComposerDraftActions): void {
  switch (request.kind) {
    case 'document':
      actions.setDocument(request.document);
      break;
    case 'image':
      actions.insertImage(request.attachment);
      break;
    default:
      assertNever(request);
  }
  actions.resetHistory();
  actions.bumpEpoch();
}

export function useDraftSync({ mode, questionEpoch, actions }: UseDraftSyncParams): {
  clearDraft: () => void;
} {
  const [{ request: draftRequest }] = useStores(composerDraftStore);
  const previousModeRef = useRef(mode);

  useEffect(() => {
    const leavingQuestion = previousModeRef.current === 'question' && mode !== 'question';
    previousModeRef.current = mode;
    if (mode !== 'question' && !leavingQuestion) return;
    applyComposerDocument(createDraftDocument(''), actions);
  }, [mode, questionEpoch]);

  useEffect(() => {
    if (!draftRequest) return;
    applyComposerDraft(draftRequest, actions);
    // Consuming the request keeps it from replaying into the composer of the next screen.
    composerDraftStore.clear();
  }, [draftRequest?.epoch]);

  return { clearDraft: () => applyComposerDocument(createDraftDocument(''), actions) };
}
