import { useState, useRef } from 'react';
import { useLatestRef } from './use-latest-ref.js';

export function useSidebar(isSmall: boolean) {
  const [visible, setVisible] = useState(false);
  const [prevIsSmall, setPrevIsSmall] = useState(isSmall);
  const wasVisible = useRef(false);
  const isSmallRef = useLatestRef(isSmall);

  if (isSmall !== prevIsSmall) {
    setPrevIsSmall(isSmall);
    if (isSmall) setVisible(false);
    else if (wasVisible.current) setVisible(true);
  }

  const toggle = () => {
    if (isSmallRef.current) return;
    setVisible((prev) => {
      const next = !prev;
      wasVisible.current = next;
      return next;
    });
  };

  return { visible, toggle };
}
