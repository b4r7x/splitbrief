import { useRef, useState } from 'react';

/**
 * State for key handlers. Ink delivers every key of one stdin read before React re-renders, so ⏎
 * right after ↓ runs the handler of the render before ↓. `set` writes the value that `latest`
 * reads before it sets the state, and a handler reads `latest()`, not the rendered value.
 */
export function useKeyState<T>(initial: T): readonly [T, (next: T) => void, () => T] {
  const [value, setValue] = useState(initial);
  const latest = useRef(initial);
  const set = (next: T): void => {
    latest.current = next;
    setValue(next);
  };
  return [value, set, () => latest.current];
}
