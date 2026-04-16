import { useEffect, useRef, type ReactNode } from 'react';
import { Box, measureElement, type DOMElement } from 'ink';

export function MeasureBox({ children, onHeightChange }: { children: ReactNode; onHeightChange?: (height: number) => void }) {
  const ref = useRef<DOMElement>(null);
  const lastHeightRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (ref.current) {
      const { height } = measureElement(ref.current);
      if (lastHeightRef.current !== height) {
        lastHeightRef.current = height;
        onHeightChange?.(height);
      }
    }
  });
  return <Box ref={ref} flexDirection="column" flexShrink={0} flexGrow={0} width="100%">{children}</Box>;
}
