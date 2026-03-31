import { useState, useCallback } from 'react';
import type { OverlayType } from '../types.js';

export function useOverlay() {
  const [active, setActive] = useState<OverlayType>('none');

  const open = useCallback((type: OverlayType) => {
    setActive(type);
  }, []);

  const close = useCallback(() => {
    setActive('none');
  }, []);

  const isOpen = active !== 'none';

  return { active, open, close, isOpen };
}
