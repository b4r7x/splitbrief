import { useLayoutEffect, useRef, useState } from 'react';

/** Runs one queued entry per commit, so each entry meets the state that the entry before it left. */
export function useInputQueue<T>(run: (entry: T) => void): (entry: T) => void {
  const pending = useRef<T[]>([]);
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    const entry = pending.current.shift();
    if (entry === undefined) return;
    run(entry);
    // A direct state update here chains synchronous renders, and React stops a chain of more than 50.
    if (pending.current.length > 0) queueMicrotask(() => setTick((n) => n + 1));
  }, [tick]);

  return (entry) => {
    pending.current.push(entry);
    setTick((n) => n + 1);
  };
}
