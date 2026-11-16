import { startTransition, useEffect, useState } from 'react';
import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';

/**
 * Gives the bridge its turns: the next key, paste or mouse action waits until the app has rendered
 * the one before it, with each state that the effects of that render set.
 */
export function InputTurns({ holdInput }: { holdInput: FilteredStdin['holdInput'] }) {
  const [turn, setTurn] = useState<{ release: () => void } | null>(null);

  // React renders a transition only when no other update waits, so the turn ends after the render
  // of the input and of each state that an effect set, at every depth.
  useEffect(() => holdInput((release) => startTransition(() => setTurn({ release }))), [holdInput]);

  // An input given on inside these effects would run its handler inside React's commit.
  useEffect(() => {
    if (turn !== null) queueMicrotask(turn.release);
  }, [turn]);

  return null;
}
