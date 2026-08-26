export function fenceMarkerLength(trimmed: string): number | null {
  const match = trimmed.match(/^(`{3,})/);
  return match?.[1] ? match[1].length : null;
}

/** An equal-or-longer marker closes an open fence; a shorter one is content. */
export function nextFenceLength(current: number, trimmed: string): number {
  const marker = fenceMarkerLength(trimmed);
  if (marker === null) return current;
  if (current === 0) return marker;
  return marker >= current ? 0 : current;
}
