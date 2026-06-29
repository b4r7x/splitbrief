import { useState } from 'react';
import { useInput } from 'ink';

interface UseCompletionNavigationOptions<TSnapshot> {
  isActive: boolean;
  latestRef: { current: TSnapshot | null };
  hasItems: (latest: TSnapshot) => boolean;
  onMove: (latest: TSnapshot, direction: -1 | 1) => void;
  onSelect: (latest: TSnapshot) => void;
  onEscape: (latest: TSnapshot) => void;
  onTab?: (latest: TSnapshot) => void;
  onReturn?: (latest: TSnapshot) => void;
}

export function useCompletionNavigation<TSnapshot>(
  options: UseCompletionNavigationOptions<TSnapshot>,
): { inputKey: number; bumpInputKey: () => void } {
  const [inputKey, setInputKey] = useState(0);
  const bumpInputKey = () => setInputKey((k) => k + 1);
  useInput(
    (_input, key) => {
      const latest = options.latestRef.current;
      if (!latest) return;
      if (key.escape) {
        options.onEscape(latest);
        return;
      }
      // Enter owners (e.g. the command menu) decide for themselves what an empty list means, so they
      // run before the items guard — that lets an unmatched slash line still reach the dispatcher.
      if (key.return && options.onReturn) {
        options.onReturn(latest);
        return;
      }
      if (!options.hasItems(latest)) return;
      if (key.upArrow) {
        options.onMove(latest, -1);
        return;
      }
      if (key.downArrow) {
        options.onMove(latest, 1);
        return;
      }
      if (key.tab) {
        (options.onTab ?? options.onSelect)(latest);
        return;
      }
      if (key.return) {
        options.onSelect(latest);
        return;
      }
    },
    { isActive: options.isActive },
  );
  return { inputKey, bumpInputKey };
}
