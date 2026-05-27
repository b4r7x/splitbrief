import { useRef, useState } from 'react';
import { rotateIndex } from '../../pickers/picker-utils.js';

interface SelectionState {
  key: string;
  index: number;
}

type SelectionSnapshot = {
  selectionKey: string;
  itemCount: number;
};

type SelectedSnapshot<TSnapshot extends SelectionSnapshot> = TSnapshot & {
  effectiveSelectedIndex: number;
};

export function useCompletionSelection<TSnapshot extends SelectionSnapshot>(snapshot: TSnapshot) {
  const [selection, setSelection] = useState<SelectionState>({ key: '', index: 0 });
  const selectedIndex = selection.key === snapshot.selectionKey ? selection.index : 0;
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, snapshot.itemCount - 1));
  const latestRef = useRef<SelectedSnapshot<TSnapshot> | null>(null);
  latestRef.current = { ...snapshot, effectiveSelectedIndex };

  function moveSelection(latest: SelectedSnapshot<TSnapshot>, direction: -1 | 1): void {
    if (latest.itemCount === 0) return;
    setSelection({
      key: latest.selectionKey,
      index: rotateIndex(latest.effectiveSelectedIndex, latest.itemCount, direction),
    });
  }

  return { effectiveSelectedIndex, latestRef, moveSelection };
}
