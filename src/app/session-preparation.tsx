import { useEffect } from 'react';
import { usePreparationKeys } from '../features/start-preparation/use-preparation-keys.js';
import { panelModel } from '../components/preparation-problem.js';
import {
  cancelSessionPreparation,
  retrySessionPreparation,
  sessionSelectStore,
} from '../stores/navigation/session-select.js';
import { approvalPromptStore, closeApprovalPrompt } from '../stores/prompts/approval.js';
import { overlayStore, selectHasOverlay } from '../stores/ui/overlay.js';
import { PreparationGate } from './preparation-gate.js';

/** Only an approval awaiting an answer covers the run. */
export function useSessionPreparationTakesPage(): boolean {
  const kind = sessionSelectStore.use((snapshot) => snapshot.preparation.kind);
  const approvalPending = approvalPromptStore.use((snapshot) => snapshot.status === 'pending');
  return kind === 'preparing' && approvalPending;
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
  const problem = panelModel(state);
  usePreparationKeys({
    active: !takesPage && (state.kind === 'preparing' || problem !== null),
    problem,
    retry: retrySessionPreparation,
    onCancel: () => cancelSessionPreparation(),
  });

  return takesPage && !hasOverlay ? <PreparationGate /> : null;
}
