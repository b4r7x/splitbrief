import { ApprovalPrompt } from '../features/workflow/components/approval-prompt/prompt.js';
import { StartPreparationPanel } from '../features/start-preparation/panel.js';
import { preparationStore } from '../stores/navigation/preparation.js';
import { overlayStore } from '../stores/ui/overlay.js';

export function PreparationGate() {
  return (
    <StartPreparationPanel
      state={{ kind: 'preparing' }}
      onBack={overlayStore.close}
      approvalPrompt={(card) => <ApprovalPrompt card={card} />}
    />
  );
}

export function PreparationDetails() {
  const state = preparationStore.use((snapshot) => snapshot);
  if (state.kind !== 'blocked' && state.kind !== 'failed') return null;
  return <StartPreparationPanel state={state} onBack={overlayStore.close} />;
}
