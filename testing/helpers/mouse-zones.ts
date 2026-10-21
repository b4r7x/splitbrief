import { hitTopmostZone } from '../../src/lib/terminal/mouse-zones.js';
import type { FilteredStdin, MouseEvent } from '../../src/lib/terminal/filtered-stdin/types.js';

export function collectClickableZones({
  cols,
  rows,
}: {
  cols: number;
  rows: number;
}): Map<string, () => void> {
  const zones = new Map<string, () => void>();
  for (let y = 1; y <= rows; y++) {
    for (let x = 1; x <= cols; x++) {
      const zone = hitTopmostZone(x, y);
      if (zone?.onClick && !zones.has(zone.id)) zones.set(zone.id, zone.onClick);
    }
  }
  return zones;
}

export function createMockFilteredStdin() {
  let listener: ((event: MouseEvent) => void) | undefined;
  return {
    filtered: {
      stdin: process.stdin as unknown as NodeJS.ReadStream,
      onMouse: (next: (event: MouseEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      activate: () => {},
      isPasteActive: () => false,
      disable: () => {},
    } satisfies FilteredStdin,
    emit: (event: MouseEvent) => listener?.(event),
  };
}

export function pointerEvent(type: MouseEvent['type'], x: number, y: number): MouseEvent {
  const button = type === 'wheel-up' ? 64 : type === 'wheel-down' ? 65 : type === 'move' ? 3 : 0;
  return { type, x, y, button, shift: false, meta: false, ctrl: false };
}
