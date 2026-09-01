import { useEffect, useRef } from 'react';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { useStores } from '../../stores/use-stores.js';
import type { InputMode } from '../../core/navigation/types.js';

interface ComposerDraftActions {
  setValue: (value: string) => void;
  clearPastes: () => void;
  resetHistory: () => void;
  bumpEpoch: () => void;
}

interface UseDraftSyncParams {
  mode: InputMode;
  questionEpoch: number | undefined;
  draftRestore: Readonly<{ epoch: number; value: string }> | undefined;
  actions: ComposerDraftActions;
}

function applyComposerDraft(value: string, actions: ComposerDraftActions): void {
  actions.setValue(value);
  actions.clearPastes();
  actions.resetHistory();
  actions.bumpEpoch();
}

export function useDraftSync({ mode, questionEpoch, draftRestore, actions }: UseDraftSyncParams): {
  clearDraft: () => void;
} {
  const [{ request: draftRequest }] = useStores(composerDraftStore);
  const previousModeRef = useRef(mode);

  useEffect(() => {
    const leavingQuestion = previousModeRef.current === 'question' && mode !== 'question';
    previousModeRef.current = mode;
    if (mode !== 'question' && !leavingQuestion) return;
    applyComposerDraft('', actions);
  }, [mode, questionEpoch]);

  useEffect(() => {
    if (!draftRestore) return;
    applyComposerDraft(draftRestore.value, actions);
  }, [draftRestore?.epoch]);

  useEffect(() => {
    if (!draftRequest) return;
    applyComposerDraft(draftRequest.value, actions);
    // Consuming the request keeps it from replaying into the composer of the next screen.
    composerDraftStore.clear();
  }, [draftRequest?.epoch]);

  return { clearDraft: () => applyComposerDraft('', actions) };
}
