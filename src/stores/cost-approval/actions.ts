import type { CostPrediction } from '../../core/schemas/summary.js';
import { createPromptChannel } from '../shared/prompt-channel.js';
import { _costApprovalInternal } from './store.js';

const channel = createPromptChannel<CostPrediction, boolean>({
  get: () => _costApprovalInternal.get(),
  setPending: (prediction, resolve) =>
    _costApprovalInternal.set({ status: 'pending', prediction, resolve }),
  setIdle: () => _costApprovalInternal.set({ status: 'idle' }),
  supersededValue: false,
  cancelledValue: false,
});

export function openCostApprovalPrompt(prediction: CostPrediction): Promise<boolean> {
  return channel.open(prediction);
}

export function closeCostApprovalPrompt(approved: boolean): void {
  channel.close(approved);
}
