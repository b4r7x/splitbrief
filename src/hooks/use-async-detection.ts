import { useState, useEffect, useEffectEvent } from 'react';

export function useAsyncDetection<T>(detect: () => Promise<T[]>): T[] | null {
  const [result, setResult] = useState<T[] | null>(null);
  const stableDetect = useEffectEvent(detect);
  useEffect(() => {
    let cancelled = false;
    stableDetect().then(data => {
      if (!cancelled) setResult(data);
    }).catch(() => {
      if (!cancelled) setResult([]);
    });
    return () => { cancelled = true; };
  }, []);
  return result;
}
