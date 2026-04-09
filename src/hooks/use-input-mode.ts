import { useState, useRef, useEffect } from 'react';
import type { InputMode } from '../types.js';

type ReviewResult = { approved: boolean; comment?: string | undefined };

export function useInputMode() {
  const [modeState, setModeState] = useState<{ mode: InputMode; hint: string }>({ mode: 'normal', hint: '' });
  const reviewResolverRef = useRef<((value: ReviewResult) => void) | null>(null);
  const questionResolverRef = useRef<((value: string) => void) | null>(null);
  const setReviewMode = (h: string): Promise<ReviewResult> => {
    return new Promise((resolve) => {
      reviewResolverRef.current = resolve;
      setModeState({ mode: 'review', hint: h });
    });
  };

  const setQuestionMode = (h: string): Promise<string> => {
    return new Promise((resolve) => {
      questionResolverRef.current = resolve;
      setModeState({ mode: 'question', hint: h });
    });
  };

  const resolve = (value: ReviewResult | string): void => {
    const currentMode = modeState.mode;
    setModeState({ mode: 'normal', hint: '' });
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
    reviewResolver?.({ approved: false });
    questionResolver?.('');
  };

  useEffect(() => {
    return () => {
      reviewResolverRef.current?.({ approved: false });
      questionResolverRef.current?.('');
      reviewResolverRef.current = null;
      questionResolverRef.current = null;
    };
  }, []);

  return { mode: modeState.mode, hint: modeState.hint, setReviewMode, setQuestionMode, resolve, resetMode };
}
