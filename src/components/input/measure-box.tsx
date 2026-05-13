import { useEffectEvent, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Box, measureElement, type DOMElement } from 'ink';

interface MeasureBoxProps {
  children: ReactNode;
  onHeightChange?: (height: number) => void;
  measureKey?: string | number;
}

export function MeasureBox({ children, onHeightChange, measureKey }: MeasureBoxProps) {
  const ref = useRef<DOMElement>(null);
  const lastHeightRef = useRef<number | undefined>(undefined);
  const stableHeightChange = useEffectEvent((h: number) => onHeightChange?.(h));

  useLayoutEffect(() => {
    if (ref.current) {
      const { height } = measureElement(ref.current);
      if (lastHeightRef.current !== height) {
        lastHeightRef.current = height;
        stableHeightChange(height);
      }
    }
  }, [measureKey ?? null]);

  return <Box ref={ref} flexDirection="column" flexShrink={0} flexGrow={0} width="100%">{children}</Box>;
}
