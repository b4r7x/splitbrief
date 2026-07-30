import { useRef, useState } from 'react';

export type CopyFeedbackState = 'copied' | 'failed' | 'idle';

export function useCopyFeedback() {
  const [copyState, setCopyState] = useState<CopyFeedbackState>('idle');
  const requestRevisionRef = useRef(0);

  async function copyText(text: string | null | undefined): Promise<void> {
    requestRevisionRef.current += 1;
    const requestRevision = requestRevisionRef.current;

    if (typeof text !== 'string') {
      setCopyState('failed');
      return;
    }

    try {
      if (!navigator.clipboard) {
        setCopyState('failed');
        return;
      }

      await navigator.clipboard.writeText(text);
      if (requestRevision !== requestRevisionRef.current) return;
      setCopyState('copied');
    } catch {
      if (requestRevision !== requestRevisionRef.current) return;
      setCopyState('failed');
    }
  }

  return { copyState, copyText };
}
