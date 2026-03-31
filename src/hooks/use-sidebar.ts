import { useState, useEffect, useCallback, useRef } from 'react';
import { useStdout } from 'ink';

const MIN_WIDTH = 100;

export function useSidebar() {
  const { stdout } = useStdout();
  const [visible, setVisible] = useState(false);
  const wasVisible = useRef(false);

  const width = stdout?.columns ?? 80;

  const toggle = useCallback(() => {
    if (width < MIN_WIDTH) return;
    setVisible((prev) => {
      const next = !prev;
      wasVisible.current = next;
      return next;
    });
  }, [width]);

  useEffect(() => {
    if (width < MIN_WIDTH && visible) {
      setVisible(false);
    } else if (width >= MIN_WIDTH && !visible && wasVisible.current) {
      setVisible(true);
    }
  }, [width, visible]);

  return { visible, toggle };
}
