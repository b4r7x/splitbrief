import { vi } from 'vitest';
import {
  plainAnswer,
  type UseInputModeResult,
} from '../../src/features/workflow/hooks/use-input-mode.js';

export function makeInputMode(mode: UseInputModeResult['mode'] = 'review'): UseInputModeResult {
  return {
    mode,
    hint: '',
    questionEpoch: 0,
    setReviewMode: vi.fn(async () => ({ approved: false as const })),
    setQuestionMode: vi.fn(async () => plainAnswer('')),
    resolve: vi.fn(),
    resetMode: vi.fn(),
  };
}
