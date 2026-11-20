import { useEffect, useRef } from 'react';
import { composerDraftStore, type ComposerDraftRequest } from '../../stores/ui/composer-draft.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { useStores } from '../../stores/use-many.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import type { InputMode } from '../../core/navigation/types.js';
import { assertNever } from '../../utils/type-guards.js';

interface ComposerDraftActions {
  setDocument: (document: DraftDocument) => void;
  holdDocument: (front: DraftDocument) => void;
  prependDocument: (front: DraftDocument) => void;
  insertImage: (attachment: Attachment) => void;
  resetHistory: () => void;
  holdMenus: () => void;
  bumpEpoch: () => void;
}

interface UseDraftSyncParams {
  mode: InputMode;
  questionEpoch: number | undefined;
  inputEpoch: number;
  actions: ComposerDraftActions;
}

function applyComposerDocument(document: DraftDocument, actions: ComposerDraftActions): void {
  actions.resetHistory();
  actions.setDocument(document);
  actions.bumpEpoch();
}

function applyComposerDraft(request: ComposerDraftRequest, actions: ComposerDraftActions): void {
  actions.resetHistory();
  switch (request.kind) {
    case 'document':
      actions.setDocument(request.document);
      break;
    case 'command':
      actions.holdDocument(request.document);
      break;
    case 'prepend':
      actions.prependDocument(request.document);
      actions.holdMenus();
      break;
    case 'image':
      actions.insertImage(request.attachment);
      break;
    default:
      assertNever(request);
  }
  actions.bumpEpoch();
}

export function useDraftSync({ mode, questionEpoch, inputEpoch, actions }: UseDraftSyncParams): {
  clearDraft: () => void;
} {
  const [{ request: draftRequest }] = useStores(composerDraftStore);
  // A mode change never clears: the composer holds one unsent session draft whether the run is
  // asking a question or not. Only a new question replacing one that owned the composer clears,
  // because text typed against the previous question is a stale answer, not a draft.
  const previousRef = useRef({ mode, epoch: questionEpoch });
  const afterCommitRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { mode, epoch: questionEpoch };
    const staleAnswer =
      mode === 'question' && previous.mode === 'question' && questionEpoch !== previous.epoch;
    if (staleAnswer) applyComposerDocument(createDraftDocument(''), actions);
  }, [mode, questionEpoch]);

  // The request bumps the input epoch. Its notice must wait for the draft in that commit.
  useEffect(() => {
    const afterCommit = afterCommitRef.current;
    afterCommitRef.current = undefined;
    afterCommit?.();
  }, [inputEpoch]);

  useEffect(() => {
    if (!draftRequest) return;
    afterCommitRef.current = draftRequest.kind === 'prepend' ? draftRequest.afterCommit : undefined;
    applyComposerDraft(draftRequest, actions);
    // Consuming the request keeps it from replaying into the composer of the next screen.
    composerDraftStore.clear();
  }, [draftRequest?.epoch]);

  return { clearDraft: () => applyComposerDocument(createDraftDocument(''), actions) };
}
