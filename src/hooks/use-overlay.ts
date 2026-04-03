import { useState } from 'react';
import type { OverlayType } from '../types.js';

export function useOverlay() {
  const [active, setActive] = useState<OverlayType>('none');
  const [exclusiveInput, setExclusiveInput] = useState(false);

  const open = (type: OverlayType) => setActive(type);
  const close = () => {
    setActive('none');
    setExclusiveInput(false);
  };
  const setExclusive = (v: boolean) => setExclusiveInput(v);

  const isOpen = active !== 'none';

  return { active, open, close, isOpen, exclusiveInput, setExclusive };
}
