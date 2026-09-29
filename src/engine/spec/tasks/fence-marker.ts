export function fenceMarkerLength(trimmed: string): number | null {
  const match = trimmed.match(/^(`{3,})/);
  return match?.[1] ? match[1].length : null;
}

/**
 * An equal-or-longer marker closes an open fence only when whitespace follows it; a shorter
 * marker or one carrying an info string is content.
 */
export function nextFenceLength(current: number, trimmed: string): number {
  const marker = fenceMarkerLength(trimmed);
  if (marker === null) return current;
  if (current === 0) return marker;
  if (marker < current || trimmed.slice(marker).trim() !== '') return current;
  return 0;
}

/**
 * A later marker closes the open fence when it is at least as long and belongs to it: an
 * info-free marker always closes, and one carrying an info string closes the fence that names
 * it — or a fence that named none. A bare marker is never certainly an opener, so the marker
 * after it pairs with it whatever it says (validator finding, 2026-09-26).
 */
export function closesOpenFence(input: {
  fenceLength: number;
  fenceInfo: string;
  markerLength: number;
  markerInfo: string;
}): boolean {
  const { fenceLength, fenceInfo, markerLength, markerInfo } = input;
  if (markerLength < fenceLength) return false;
  return markerInfo === '' || markerInfo === fenceInfo || fenceInfo === '';
}
