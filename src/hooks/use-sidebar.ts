import { useState, useRef } from 'react';

export function useSidebar(isSmall: boolean) {
  const [visible, setVisible] = useState(false);
  const wasVisible = useRef(false);

  const toggle = () => {
    if (isSmall) return;
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
