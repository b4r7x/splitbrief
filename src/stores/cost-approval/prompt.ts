import { createStore, storeBase } from '../create-store.js';
import { createPromptChannel } from '../channels/prompt.js';
import type { CostPrediction } from '../../core/schemas/summary.js';

export type CostApprovalState =
  | { status: 'idle' }
  | {
      status: 'pending';
      prediction: CostPrediction;
      resolve: (approved: boolean) => void;
    };

const initial: CostApprovalState = { status: 'idle' };
const store = createStore<CostApprovalState>(initial);

function __testReset(next?: CostApprovalState): void {
  store.set(next ?? initial);
}

const _costApprovalInternal = { set: store.set, get: store.get };

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

export function closeCostApprovalPrompt(result: { approved: boolean }): void {
  const { approved } = result;
  channel.close(approved);
}

export const costApprovalStore = {
  ...storeBase(store),
  __testReset,
};
