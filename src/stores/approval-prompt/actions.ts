import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';
import { createPromptChannel } from '../shared/prompt-channel.js';
import { _approvalPromptInternal } from './store.js';

const channel = createPromptChannel<TieredApprovalRequest, TieredApprovalResponse>({
  get: () => _approvalPromptInternal.get(),
  setPending: (request, resolve) =>
    _approvalPromptInternal.set({ status: 'pending', request, resolve }),
  setIdle: () => _approvalPromptInternal.set({ status: 'idle' }),
  supersededValue: { decision: 'deny', reason: 'superseded' },
  cancelledValue: { decision: 'deny', reason: 'user_cancelled' },
});

export function openApprovalPrompt(
  request: TieredApprovalRequest,
): Promise<TieredApprovalResponse> {
  return channel.open(request);
}

export function closeApprovalPrompt(response?: TieredApprovalResponse): void {
  channel.close(response);
}
