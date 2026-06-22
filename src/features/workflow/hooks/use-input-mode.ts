import { useState, useRef, useEffect } from 'react';
import type { InputMode } from '../../../core/navigation/types.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { controlsStore } from '../../../stores/ui/controls.js';

export interface UseInputModeResult {
  mode: InputMode;
  hint: string;
  setReviewMode: (h: string) => Promise<ApprovalReviewResult>;
  setQuestionMode: (h: string) => Promise<string>;
  resolve: (value: ApprovalReviewResult | string) => void;
  resetMode: () => void;
}

export function useInputMode(): UseInputModeResult {
  const [modeState, setModeState] = useState<{ mode: InputMode; hint: string }>({
    mode: 'normal',
    hint: '',
  });
  // Mirror committed mode into a ref: resolve() can be invoked after `await` boundaries
  // (e.g. review-parser.ts awaits openInEditor before calling resolve), where a captured
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
    reviewResolver?.({ approved: false });
    questionResolver?.('');
  };

  const setReviewMode = (h: string): Promise<ApprovalReviewResult> => {
    supersedePending();
    return new Promise((resolve) => {
      reviewResolverRef.current = resolve;
      setModeState({ mode: 'review', hint: h });
      controlsStore.setInputMode('review');
    });
  };

  const setQuestionMode = (h: string): Promise<string> => {
    supersedePending();
    return new Promise((resolve) => {
      questionResolverRef.current = resolve;
      setModeState({ mode: 'question', hint: h });
      controlsStore.setInputMode('question');
    });
  };

  const resolve = (value: ApprovalReviewResult | string): void => {
    const currentMode = modeRef.current;
    setModeState({ mode: 'normal', hint: '' });
    controlsStore.clearInputMode();
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
    setModeState({ mode: 'normal', hint: '' });
    controlsStore.clearInputMode();
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
    };
  }, []);

  return {
    mode: modeState.mode,
    hint: modeState.hint,
    setReviewMode,
    setQuestionMode,
    resolve,
    resetMode,
  };
}
