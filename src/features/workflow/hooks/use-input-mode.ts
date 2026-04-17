import { useState, useRef, useEffect } from 'react';
import type { InputMode } from '../../../core/types/app.js';
import { controlsStore } from '../../../stores/ui/controls.js';

type ReviewResult = { approved: boolean; comment?: string | undefined };

export interface UseInputModeResult {
  mode: InputMode;
  hint: string;
  setReviewMode: (h: string) => Promise<ReviewResult>;
  setQuestionMode: (h: string) => Promise<string>;
  resolve: (value: ReviewResult | string) => void;
  resetMode: () => void;
}

export function useInputMode(): UseInputModeResult {
  const [modeState, setModeState] = useState<{ mode: InputMode; hint: string }>({ mode: 'normal', hint: '' });
  const modeRef = useRef(modeState.mode);
  modeRef.current = modeState.mode;
  const reviewResolverRef = useRef<((value: ReviewResult) => void) | null>(null);
  const questionResolverRef = useRef<((value: string) => void) | null>(null);

  useEffect(() => {
    return () => controlsStore.clearInputMode();
  }, []);

  const setReviewMode = (h: string): Promise<ReviewResult> => {
    return new Promise((resolve) => {
      reviewResolverRef.current = resolve;
      setModeState({ mode: 'review', hint: h });
      controlsStore.setInputMode('review');
    });
  };

  const setQuestionMode = (h: string): Promise<string> => {
    return new Promise((resolve) => {
      questionResolverRef.current = resolve;
      setModeState({ mode: 'question', hint: h });
      controlsStore.setInputMode('question');
    });
  };

  const resolve = (value: ReviewResult | string): void => {
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
    };
  }, []);

  return { mode: modeState.mode, hint: modeState.hint, setReviewMode, setQuestionMode, resolve, resetMode };
}
