import { createStore, storeBase } from '../create-store.js';
import { createPromptChannel } from '../channels/prompt.js';
import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';

export type ApprovalPromptState =
  | { status: 'idle' }
  | {
      status: 'pending';
      request: TieredApprovalRequest;
      resolve: (response: TieredApprovalResponse) => void;
    };

const initial: ApprovalPromptState = { status: 'idle' };
const store = createStore<ApprovalPromptState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: ApprovalPromptState): void {
  store.set(next ?? initial);
}

const _approvalPromptInternal = { set: store.set, get: store.get };

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

export const approvalPromptStore = {
  ...storeBase(store),
  __testReset,
};
