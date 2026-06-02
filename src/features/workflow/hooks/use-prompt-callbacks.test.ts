import { describe, it, expect } from 'vitest';
import { usePromptCallbacks } from './use-prompt-callbacks.js';
import type { UseInputModeResult } from './use-input-mode.js';

function makeInputMode(answer: string): UseInputModeResult {
  return {
    mode: 'normal',
    hint: '',
    setReviewMode: async () => ({ approved: false }),
    setQuestionMode: async () => answer,
    resolve: () => {},
    resetMode: () => {},
  };
}

describe('usePromptCallbacks onBudgetExceeded', () => {
  it('resolves to false regardless of the user answer (hard stop)', async () => {
    const buildCallbacks = usePromptCallbacks();
    for (const answer of ['continue', 'c', 'pause', 'abort', '']) {
      const callbacks = buildCallbacks({
        inputMode: makeInputMode(answer),
        abortedRef: { current: false },
        controller: new AbortController(),
        onComplete: () => {},
      });
      const result = await callbacks.onBudgetExceeded?.(150, 100);
      expect(result).toBe(false);
    }
  });
});
