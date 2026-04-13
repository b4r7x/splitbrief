import { useState, useEffect } from 'react';
import { highlight } from '../utils/highlight.js';

export function useAsyncHighlight(code: string, lang?: string): string | null {
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    highlight(code, lang).then((out) => {
      if (!cancelled) setResult(out.replace(/\n$/, ''));
    }).catch(() => { /* highlight failure is non-critical — render unhighlighted */ });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return result;
}
