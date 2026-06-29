import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Box, measureElement, type DOMElement } from 'ink';
import { registerMouseZone } from '../../lib/terminal/mouse-zones.js';

export const ROW_ZONE_Z_OVERLAY = 100;
export const ROW_ZONE_Z_SCREEN = 50;

export interface RowSgrRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function measureRowSgr(node: DOMElement): RowSgrRect | null {
  let top = 0;
  let left = 0;
  let current: DOMElement | undefined = node;
  while (current?.parentNode) {
    if (!current.yogaNode) return null;
    top += current.yogaNode.getComputedTop();
    left += current.yogaNode.getComputedLeft();
    current = current.parentNode;
  }
  const { width, height } = measureElement(node);
  if (width <= 0 || height <= 0) return null;
  return { top: top + 1, left: left + 1, width, height };
}

export function rowZoneRect(rect: RowSgrRect): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  return {
    left: rect.left,
    right: rect.left + rect.width - 1,
    top: rect.top,
    bottom: rect.top + rect.height - 1,
  };
}

interface RowZoneProps {
  zoneId: string;
  z: number;
  onActivate: () => void;
  children: ReactNode;
}

export function RowZone({ zoneId, z, onActivate, children }: RowZoneProps) {
  const ref = useRef<DOMElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = measureRowSgr(node);
    if (!rect) return;
    return registerMouseZone({ id: zoneId, ...rowZoneRect(rect), z, onClick: onActivate });
  }, [zoneId, z, onActivate]);
  return <Box ref={ref}>{children}</Box>;
}
