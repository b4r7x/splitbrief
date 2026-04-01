export function computeScrollOffset(index: number, windowSize: number, totalItems: number): number {
  if (totalItems <= windowSize) return 0;
  const half = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(index - half, totalItems - windowSize));
}

export function truncate(str: string, max: number): string {
  if (max <= 0) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}
