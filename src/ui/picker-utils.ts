export function computeScrollOffset(index: number, windowSize: number, totalItems: number): number {
  if (totalItems <= windowSize) return 0;
  const half = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(index - half, totalItems - windowSize));
}
