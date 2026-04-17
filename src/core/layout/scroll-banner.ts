export function computeScrollBannerText(
  linesAbove: number,
  linesBelow: number,
): { above: string; below: string } {
  return {
    above: linesAbove > 0 ? `─── ${linesAbove} line${linesAbove === 1 ? '' : 's'} above ───` : '',
    below: linesBelow > 0 ? `─── ${linesBelow} line${linesBelow === 1 ? '' : 's'} below ───` : '',
  };
}
