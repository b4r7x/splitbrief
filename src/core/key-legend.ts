import { SOFT_SEP } from './separators.js';

/**
 * A legend that ends in an ellipsis has cut a key in half and still claims to name it. Too narrow a
 * row drops whole trailing tokens instead, so everything left standing is a complete, live key.
 */
export function fitKeyLegend(legend: string, width: number): string {
  if (legend.length <= width) return legend;
  let fitted = '';
  for (const token of legend.split(SOFT_SEP)) {
    const next = fitted === '' ? token : `${fitted}${SOFT_SEP}${token}`;
    if (next.length > width) break;
    fitted = next;
  }
  return fitted;
}
