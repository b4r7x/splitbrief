export interface MouseZone {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  z: number;
  onClick?: () => void;
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

export function unregisterMouseZone(id: string): void {
  zones = zones.filter((zone) => zone.id !== id);
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

export function _resetMouseZones(): void {
  zones = [];
}
