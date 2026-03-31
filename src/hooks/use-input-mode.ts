import { useState, useRef } from 'react';
import type { InputMode } from '../types.js';

export function useInputMode() {
  const [mode, setMode] = useState<InputMode>('normal');
  const [hint, setHint] = useState('');
  const resolverRef = useRef<((value: unknown) => void) | null>(null);

  const setReviewMode = (h: string): Promise<{ approved: boolean; comment?: string }> => {
    return new Promise((resolve) => {
      resolverRef.current = resolve as (value: unknown) => void;
      setHint(h);
      setMode('review');
    });
  };

  const setQuestionMode = (h: string): Promise<string> => {
    return new Promise((resolve) => {
      resolverRef.current = resolve as (value: unknown) => void;
      setHint(h);
      setMode('question');
    });
  };

  const resolve = (value: unknown): void => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setMode('normal');
    setHint('');
    resolver?.(value);
  };

  const resetMode = (): void => {
    resolverRef.current = null;
    setMode('normal');
    setHint('');
  };

  return { mode, hint, setReviewMode, setQuestionMode, resolve, resetMode };
}
