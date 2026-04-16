export function computeScrollBannerText(
  scrollOffset: number,
  totalHeight: number,
  viewportHeight: number,
): { above: string; below: string } {
  const overflow = Math.max(0, totalHeight - viewportHeight);
  if (overflow === 0) return { above: '', below: '' };

  const linesAbove = Math.max(0, overflow - scrollOffset);
  const linesBelow = scrollOffset;

  return {
    above: linesAbove > 0 ? `─── ${linesAbove} line${linesAbove === 1 ? '' : 's'} above ───` : '',
    below: linesBelow > 0 ? `─── ${linesBelow} line${linesBelow === 1 ? '' : 's'} below ───` : '',
  };
}
