import { useState } from 'react';
import type { OverlayType } from '../types.js';

export function useOverlay() {
  const [active, setActive] = useState<OverlayType>('none');

  const open = (type: OverlayType) => setActive(type);
  const close = () => setActive('none');

  const isOpen = active !== 'none';

  return { active, open, close, isOpen };
}
