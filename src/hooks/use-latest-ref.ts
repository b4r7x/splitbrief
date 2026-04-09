import { useRef, useLayoutEffect } from 'react';

/**
 * Escape hatch for keeping a ref synced with the latest value across renders.
 * ONLY use when `useEffectEvent` is not applicable (e.g., reading from useInput handlers
 * that live outside useEffect). Prefer `useEffectEvent` inside effects.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
