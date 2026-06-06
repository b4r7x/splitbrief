import { describe, it, expect } from 'vitest';
import { buildPromptCallbacks } from './prompt-callbacks.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

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

describe('buildPromptCallbacks onBudgetExceeded', () => {
  it('resolves to false regardless of the user answer (hard stop)', async () => {
    const buildCallbacks = buildPromptCallbacks();
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
