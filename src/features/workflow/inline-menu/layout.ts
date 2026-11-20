import { planListRows } from '../../../components/list-row/plan.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

export function inlineMenuLayout(
  rows: readonly { label: string; consequence: string }[],
  cols: number,
) {
  const width = getChromeContentWidth(cols);
  const lines = planListRows(
    rows.map((row) => ({ name: row.label, description: row.consequence })),
    { width: Math.max(1, width - 4) },
  );
  return { width, lines, bodyRows: lines.length, height: lines.length + 4 };
}

/**
 * What a box of `boxHeight` rows paints around `bodyRows` action rows. The actions go first: a
 * shorter box drops the legend, then the border, then the title, and then the list scrolls.
 */
export function inlineMenuChrome(boxHeight: number, bodyRows: number) {
  const spareRows = boxHeight - bodyRows;
  return {
    framed: spareRows >= 3,
    titled: spareRows >= 1,
    legend: spareRows >= 4,
    listRows: Math.min(bodyRows, boxHeight),
    extraRows: Math.max(0, spareRows - 4),
  };
}
