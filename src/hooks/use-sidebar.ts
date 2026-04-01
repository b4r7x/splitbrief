import { useState, useEffect, useCallback, useRef } from 'react';

export function useSidebar(isSmall: boolean) {
  const [visible, setVisible] = useState(false);
  const wasVisible = useRef(false);

  const toggle = useCallback(() => {
    if (isSmall) return;
    setVisible((prev) => {
      const next = !prev;
      wasVisible.current = next;
      return next;
    });
  }, [isSmall]);

  useEffect(() => {
    setVisible(prev => {
      if (isSmall) return false;
      if (!prev && wasVisible.current) return true;
      return prev;
    });
  }, [isSmall]);

  return { visible, toggle };
}
