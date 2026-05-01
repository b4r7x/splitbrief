import type { CostPrediction } from '../../core/schemas/summary.js';
import { _costApprovalInternal } from './store.js';

export function openCostApprovalPrompt(prediction: CostPrediction): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const current = _costApprovalInternal.get();

    if (current.status === 'pending') {
      const previousResolve = current.resolve;
      _costApprovalInternal.set({ status: 'pending', prediction, resolve });
      previousResolve(false);
      return;
    }

    _costApprovalInternal.set({ status: 'pending', prediction, resolve });
  });
}

export function closeCostApprovalPrompt(approved: boolean): void {
  const current = _costApprovalInternal.get();
  _costApprovalInternal.set({ status: 'idle' });
  if (current.status === 'pending') {
    current.resolve(approved);
  }
}
