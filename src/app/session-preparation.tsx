import { useEffect } from 'react';
import { useInput } from 'ink';
import { ApprovalPrompt } from '../features/workflow/components/approval-prompt.js';
import { observePreparationCleanup } from '../features/start-preparation/observe-cleanup.js';
import { StartPreparationPanel } from '../features/start-preparation/panel.js';
import {
  cancelSessionPreparation,
  retrySessionPreparation,
  sessionSelectStore,
} from '../stores/navigation/session-select.js';
import { approvalPromptStore, closeApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import { overlayStore } from '../stores/ui/overlay.js';

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
  const approvalPending = approvalPromptStore.use((snapshot) => snapshot.status === 'pending');
  const hasOverlay = overlayStore.use((snapshot) => snapshot.active !== 'none');
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
  useInput(
    (_input, key) => {
      if (key.escape) cancelSessionPreparation();
    },
    { isActive: state.kind === 'preparing' && !takesPage && !hasOverlay },
  );

  if (!takesPage || hasOverlay) return null;

  return (
    <StartPreparationPanel
      state={state}
      onRetry={() => observePreparationCleanup(retrySessionPreparation())}
      onBack={() => {
        closeApprovalPrompt();
        cancelSessionPreparation();
      }}
      onOpenSettings={() => overlayStore.open('settings')}
      approvalPrompt={approvalPending ? <ApprovalPrompt /> : undefined}
    />
  );
}
