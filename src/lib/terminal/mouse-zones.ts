import type { MouseAction } from './filtered-stdin/types.js';

export interface MouseZone {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  z: number;
  /** The row that drew the zone: it stays the same while that row stays on screen. */
  owner: object;
  onClick?: () => void;
  onWheel?: (direction: 'up' | 'down') => void;
}

let zones: MouseZone[] = [];

export function registerMouseZone(zone: MouseZone): () => void {
  zones = [...zones.filter((existing) => existing.id !== zone.id), zone];
  return () => {
    if (zones.includes(zone)) {
      zones = zones.filter((existing) => existing !== zone);
    }
  };
}

export function hitTopmostZone(
  x: number,
  y: number,
  opts?: { minZ?: number },
): MouseZone | undefined {
  const minZ = opts?.minZ ?? Number.NEGATIVE_INFINITY;
  let best: MouseZone | undefined;
  for (const zone of zones) {
    if (zone.z < minZ) continue;
    if (x < zone.left || x > zone.right || y < zone.top || y > zone.bottom) continue;
    if (!best || zone.z > best.z) best = zone;
  }
  return best;
}

/**
 * Reads a click against the zones of the frame on screen. The action it returns clicks the zone
 * that the same row holds under the same id when the action runs, so the click acts on the row that
 * the frame showed, where the input before it left that row, or on nothing once the row is gone.
 */
export function clickAt(x: number, y: number, opts?: { minZ?: number }): MouseAction | undefined {
  const drawn = hitTopmostZone(x, y, opts);
  if (drawn === undefined) return undefined;
  return () =>
    zones.find((zone) => zone.id === drawn.id && zone.owner === drawn.owner)?.onClick?.();
}

export function _resetMouseZones(): void {
  zones = [];
}
