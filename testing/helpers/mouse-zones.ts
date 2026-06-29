import { hitTopmostZone } from '../../src/lib/terminal/mouse-zones.js';

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
