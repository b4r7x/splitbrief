import type { TieredApprovalRequest, TieredApprovalResponse } from './store.js';
import { _approvalPromptInternal } from './store.js';

export function openApprovalPrompt(request: TieredApprovalRequest): Promise<TieredApprovalResponse> {
  return new Promise<TieredApprovalResponse>((resolve) => {
    const current = _approvalPromptInternal.get();

    // Supersede any existing pending prompt
    if (current.status === 'pending') {
      const previousResolve = current.resolve;
      _approvalPromptInternal.set({ status: 'pending', request, resolve });
      previousResolve({ decision: 'deny', reason: 'superseded' });
      return;
    }

    _approvalPromptInternal.set({ status: 'pending', request, resolve });
  });
}

export function closeApprovalPrompt(): void {
  _approvalPromptInternal.set({ status: 'idle' });
}
