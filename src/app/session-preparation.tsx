import { useEffect } from 'react';
import { useCancelKey } from '../features/start-preparation/use-cancel-key.js';
import {
  cancelSessionPreparation,
  retrySessionPreparation,
  sessionSelectStore,
} from '../stores/navigation/session-select.js';
import { approvalPromptStore, closeApprovalPrompt } from '../stores/prompts/approval.js';
import { overlayStore, selectHasOverlay } from '../stores/ui/overlay.js';
import { PreparationGate } from './preparation-gate.js';

/**
 * The page belongs to a continuation only while there is something to do on it: an approval to
 * answer, or a problem with a repair action. A routine check keeps the run on its own screen, where
 * the status sits beside the composer.
 */
export function useSessionPreparationTakesPage(): boolean {
  const kind = sessionSelectStore.use((snapshot) => snapshot.preparation.kind);
  const approvalPending = approvalPromptStore.use((snapshot) => snapshot.status === 'pending');
  return kind === 'blocked' || kind === 'failed' || (kind === 'preparing' && approvalPending);
}

export function SessionPreparation() {
  const state = sessionSelectStore.use((snapshot) => snapshot.preparation);
  const hasOverlay = overlayStore.use(selectHasOverlay);
  const takesPage = useSessionPreparationTakesPage();

  useEffect(
    () => () => {
      closeApprovalPrompt();
      cancelSessionPreparation({ restoreOrigin: false });
    },
    [],
  );

  // Escape spends this attempt and nothing else: the run stays on its screen and the draft beside
  // it is left exactly as it was.
  useCancelKey({
    preparing: state.kind === 'preparing',
    takesPage,
    onCancel: () => cancelSessionPreparation(),
  });

  if (!takesPage || hasOverlay) return null;

  return (
    <PreparationGate
      state={state}
      retry={retrySessionPreparation}
      onBack={() => {
        closeApprovalPrompt();
        cancelSessionPreparation();
      }}
    />
  );
}
