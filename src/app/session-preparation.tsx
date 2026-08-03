import { useEffect } from 'react';
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

export function SessionPreparation() {
  const state = sessionSelectStore.use((snapshot) => snapshot.preparation);
  const approvalPending = approvalPromptStore.use((snapshot) => snapshot.status === 'pending');

  useEffect(
    () => () => {
      closeApprovalPrompt();
      cancelSessionPreparation({ restoreOrigin: false });
    },
    [],
  );

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
