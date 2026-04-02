import { useState, useRef } from 'react';
import { useLatestRef } from './use-latest-ref.js';

export function useSidebar(isSmall: boolean) {
  const [visible, setVisible] = useState(false);
  const wasVisible = useRef(false);
  const isSmallRef = useLatestRef(isSmall);

  const toggle = () => {
    if (isSmallRef.current) return;
    setVisible((prev) => {
      const next = !prev;
      wasVisible.current = next;
      return next;
    });
  };

  const [prevIsSmall, setPrevIsSmall] = useState(isSmall);
  if (isSmall !== prevIsSmall) {
    setPrevIsSmall(isSmall);
    if (isSmall) {
      setVisible(false);
    } else if (wasVisible.current) {
      setVisible(true);
    }
  }

  return { visible, toggle };
}
