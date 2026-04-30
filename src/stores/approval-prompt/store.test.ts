import { describe, it, expect, beforeEach } from 'vitest';
import { approvalPromptStore } from './store.js';
import { openApprovalPrompt, closeApprovalPrompt } from './actions.js';
import type { TieredApprovalRequest } from './store.js';

const makeRequest = (desc = 'test action'): TieredApprovalRequest => ({
  tier: 'sticky',
  actionClass: 'write_out_of_scope',
  actionDescription: desc,
  phase: 'implementing',
});

describe('approvalPromptStore + actions', () => {
  beforeEach(() => {
    approvalPromptStore.__testReset();
  });

  it('starts idle', () => {
    expect(approvalPromptStore.get().status).toBe('idle');
  });

  it('openApprovalPrompt sets status to pending and returns a pending promise', () => {
    const p = openApprovalPrompt(makeRequest());
    const state = approvalPromptStore.get();
    expect(state.status).toBe('pending');
    if (state.status === 'pending') {
      expect(state.request.actionDescription).toBe('test action');
    }
    // Resolve via stored resolve so the promise doesn't leak
    if (state.status === 'pending') {
      state.resolve({ decision: 'deny', reason: 'cleanup' });
    }
    return p;
  });

  it('calling stored resolve settles the promise', async () => {
    const p = openApprovalPrompt(makeRequest());
    const state = approvalPromptStore.get();
    if (state.status !== 'pending') throw new Error('expected pending');
    state.resolve({ decision: 'allow', scope: 'once' });
    const result = await p;
    expect(result).toEqual({ decision: 'allow', scope: 'once' });
  });

  it('closeApprovalPrompt resets state to idle and settles as cancelled', async () => {
    const promise = openApprovalPrompt(makeRequest());
    expect(approvalPromptStore.get().status).toBe('pending');
    closeApprovalPrompt();
    expect(approvalPromptStore.get().status).toBe('idle');
    await expect(promise).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
  });

  it('closeApprovalPrompt can settle with an explicit response', async () => {
    const promise = openApprovalPrompt(makeRequest());
    closeApprovalPrompt({ decision: 'allow', scope: 'once' });
    expect(approvalPromptStore.get().status).toBe('idle');
    await expect(promise).resolves.toEqual({ decision: 'allow', scope: 'once' });
  });

  it('openApprovalPrompt while pending: previous promise resolves with superseded; new pending is set', async () => {
    const req1 = makeRequest('action-1');
    const req2 = makeRequest('action-2');

    const p1 = openApprovalPrompt(req1);
    const p2 = openApprovalPrompt(req2);

    // p1 must have resolved with superseded
    await expect(p1).resolves.toEqual({ decision: 'deny', reason: 'superseded' });

    // new state is pending with req2
    const state = approvalPromptStore.get();
    expect(state.status).toBe('pending');
    if (state.status === 'pending') {
      expect(state.request.actionDescription).toBe('action-2');
      state.resolve({ decision: 'deny', reason: 'cleanup' });
    }

    await p2;
  });
});
