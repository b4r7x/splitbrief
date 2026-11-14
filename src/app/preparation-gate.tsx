import { ApprovalPrompt } from '../features/workflow/components/approval-prompt/prompt.js';
import { observePreparationCleanup } from '../features/start-preparation/observe-cleanup.js';
import { StartPreparationPanel } from '../features/start-preparation/panel.js';
import type { StartPreparationState } from '../features/start-preparation/use-start-preparation.js';
import { approvalPromptStore } from '../stores/prompts/approval.js';
import { overlayStore } from '../stores/ui/overlay.js';

type PreparationGateProps = Readonly<{
  state: StartPreparationState;
  retry: () => Promise<void>;
  onBack: () => void;
}>;

/** The page a tool check takes: the question it waits on, or its problem with retry and settings. */
export function PreparationGate({ state, retry, onBack }: PreparationGateProps) {
  const approvalPending = approvalPromptStore.use((snapshot) => snapshot.status === 'pending');
  return (
    <StartPreparationPanel
      state={state}
      onRetry={() => observePreparationCleanup(retry())}
      onBack={onBack}
      onOpenSettings={() => overlayStore.open('settings')}
      approvalPrompt={approvalPending ? (card) => <ApprovalPrompt card={card} /> : undefined}
    />
  );
}
