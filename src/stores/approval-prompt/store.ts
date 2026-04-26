import { createStore, storeBase } from '../create-store.js';
import type { TieredApprovalRequest, TieredApprovalResponse } from '../../engine/orchestrator/tiered-approval.js';

export type { TieredApprovalRequest, TieredApprovalResponse };

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

// Internal — for use by actions.ts only.
export const _approvalPromptInternal = { set: store.set, get: store.get };

export const approvalPromptStore = {
  ...storeBase(store),
  __testReset,
};
