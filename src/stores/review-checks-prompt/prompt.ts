import { createStore, storeBase } from '../create-store.js';
import { createPromptChannel } from '../channels/prompt.js';
import { markWaitEnded, markWaitStarted } from '../workflow/actions/wait.js';
import type {
  ReviewChecksApprovalAnswer,
  ReviewChecksApprovalRequest,
} from '../../core/approval/types.js';

export type ReviewChecksPromptState =
  | { status: 'idle' }
  | {
      status: 'pending';
      request: ReviewChecksApprovalRequest;
      resolve: (answer: ReviewChecksApprovalAnswer | undefined) => void;
    };

const initial: ReviewChecksPromptState = { status: 'idle' };
const store = createStore<ReviewChecksPromptState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: ReviewChecksPromptState): void {
  store.set(next ?? initial);
}

const _reviewChecksPromptInternal = { set: store.set, get: store.get };

// A superseded or torn-down card answers nothing: the engine names that, it never reads it as Run.
const channel = createPromptChannel<
  ReviewChecksApprovalRequest,
  ReviewChecksApprovalAnswer | undefined
>({
  get: () => _reviewChecksPromptInternal.get(),
  setPending: (request, resolve) => {
    _reviewChecksPromptInternal.set({ status: 'pending', request, resolve });
    markWaitStarted();
  },
  setIdle: () => {
    const pending = _reviewChecksPromptInternal.get().status === 'pending';
    _reviewChecksPromptInternal.set({ status: 'idle' });
    if (pending) markWaitEnded();
  },
  supersededValue: undefined,
  cancelledValue: undefined,
});

export function openReviewChecksPrompt(
  request: ReviewChecksApprovalRequest,
): Promise<ReviewChecksApprovalAnswer | undefined> {
  return channel.open(request);
}

export function closeReviewChecksPrompt(answer?: ReviewChecksApprovalAnswer): void {
  channel.close(answer);
}

export const reviewChecksPromptStore = {
  ...storeBase(store),
  __testReset,
};
