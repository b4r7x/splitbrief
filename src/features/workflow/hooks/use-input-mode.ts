import { useState, useRef, useEffect } from 'react';
import type { InputMode } from '../../../core/navigation/types.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { questionPromptStore } from '../../../stores/question-prompt/prompt.js';

export interface UseInputModeResult {
  mode: InputMode;
  hint: string;
  questionEpoch: number;
  setReviewMode: (h: string) => Promise<ApprovalReviewResult>;
  setQuestionMode: (h: string) => Promise<string>;
  resolve: (value: ApprovalReviewResult | string) => void;
  resetMode: () => void;
}

export function useInputMode(): UseInputModeResult {
  const [modeState, setModeState] = useState<{
    mode: InputMode;
    hint: string;
    questionEpoch: number;
  }>({
    mode: 'normal',
    hint: '',
    questionEpoch: 0,
  });
  // Mirror committed mode into a ref: resolve() can be invoked after `await` boundaries
  // (e.g. review-parser.ts awaits runEditor before calling resolve), where a captured
  // closure value would go stale across intervening renders/mode changes.
  const modeRef = useRef(modeState.mode);
  modeRef.current = modeState.mode;
  const reviewResolverRef = useRef<((value: ApprovalReviewResult) => void) | null>(null);
  const questionResolverRef = useRef<((value: string) => void) | null>(null);

  const supersedePending = (): void => {
    const reviewResolver = reviewResolverRef.current;
    const questionResolver = questionResolverRef.current;
    reviewResolverRef.current = null;
    questionResolverRef.current = null;
    questionPromptStore.clearHint();
    reviewResolver?.({ approved: false });
    questionResolver?.('');
  };

  const setReviewMode = (h: string): Promise<ApprovalReviewResult> => {
    supersedePending();
    return new Promise((resolve) => {
      reviewResolverRef.current = resolve;
      setModeState((state) => ({ ...state, mode: 'review', hint: h }));
      controlsStore.setInputMode('review');
    });
  };

  const setQuestionMode = (h: string): Promise<string> => {
    supersedePending();
    return new Promise((resolve) => {
      questionResolverRef.current = resolve;
      questionPromptStore.setHint(h);
      setModeState((state) => ({
        mode: 'question',
        hint: h,
        questionEpoch: state.questionEpoch + 1,
      }));
      controlsStore.setInputMode('question');
    });
  };

  const resolve = (value: ApprovalReviewResult | string): void => {
    const currentMode = modeRef.current;
    setModeState((state) => ({ ...state, mode: 'normal', hint: '' }));
    controlsStore.clearInputMode();
    questionPromptStore.clearHint();
    if (currentMode === 'review' && typeof value === 'object') {
      const resolver = reviewResolverRef.current;
      reviewResolverRef.current = null;
      resolver?.(value);
    } else if (currentMode === 'question' && typeof value === 'string') {
      const resolver = questionResolverRef.current;
      questionResolverRef.current = null;
      resolver?.(value);
    }
  };

  const resetMode = (): void => {
    const reviewResolver = reviewResolverRef.current;
    const questionResolver = questionResolverRef.current;
    reviewResolverRef.current = null;
    questionResolverRef.current = null;
    setModeState((state) => ({ ...state, mode: 'normal', hint: '' }));
    controlsStore.clearInputMode();
    questionPromptStore.clearHint();
    reviewResolver?.({ approved: false });
    questionResolver?.('');
  };

  useEffect(() => {
    return () => {
      reviewResolverRef.current?.({ approved: false });
      questionResolverRef.current?.('');
      reviewResolverRef.current = null;
      questionResolverRef.current = null;
      controlsStore.clearInputMode();
      questionPromptStore.clearHint();
    };
  }, []);

  return {
    mode: modeState.mode,
    hint: modeState.hint,
    questionEpoch: modeState.questionEpoch,
    setReviewMode,
    setQuestionMode,
    resolve,
    resetMode,
  };
}
