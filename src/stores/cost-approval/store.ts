import { createStore, storeBase } from '../create-store.js';
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

export const _costApprovalInternal = { set: store.set, get: store.get };

export const costApprovalStore = {
  ...storeBase(store),
  __testReset,
};
