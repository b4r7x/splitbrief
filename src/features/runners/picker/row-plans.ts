import { wholeWordLabelForms } from '../../../components/list-row/fit.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import type { PickerOption } from '../model-catalog/options.js';
import { type ModelRowPlan, planModelRows } from '../model-catalog/row-plan.js';
import { formatPickerStatusLabel } from '../../../core/readiness/cli-remediation.js';
import type { PickerCatalog } from './use-catalog.js';

/** What a tool row spends beside its name and its word: the lead and the check column. */
const TOOL_ROW_CHROME = 4;

/**
 * A status says what is wrong with a tool, so a list that prints it on one row and not the next
 * tells the reader the others are fine. The list keeps every status or none: each one must sit
 * whole beside at least its tool's first word.
 */
function toolStatusesFit(items: readonly PickerOption[], width: number): boolean {
  const room = width - TOOL_ROW_CHROME;
  return items.every((item) => {
    const status = formatPickerStatusLabel(item.status);
    if (status === undefined) return true;
    const shortest = wholeWordLabelForms(item.displayName).at(-1) ?? item.displayName;
    return getTerminalCellWidth(shortest) + 1 + getTerminalCellWidth(status) <= room;
  });
}

/**
 * The width plans of the two columns, made again on each render. Every row of a column is drawn
 * at one width and each plan answers for the whole list, so a plan is made once, at the width the
 * first row asks for. The tool column plans its status words over every tool, not the filtered few.
 */
export function rowPlansFor(catalog: Pick<PickerCatalog, 'items' | 'rightRows' | 'currentItem'>) {
  let rowPlan: ModelRowPlan | undefined;
  let statusPlan: { width: number; fits: boolean } | undefined;
  return {
    toolRowWidth: Math.max(
      0,
      ...catalog.items.map((item) => {
        const status = formatPickerStatusLabel(item.status);
        return (
          TOOL_ROW_CHROME +
          getTerminalCellWidth(status ? `${item.displayName} ${status}` : item.displayName)
        );
      }),
    ),
    rowPlanAt: (width: number): ModelRowPlan => {
      if (rowPlan?.width !== width)
        rowPlan = planModelRows({
          rows: catalog.rightRows,
          width,
          providerId: catalog.currentItem?.id,
        });
      return rowPlan;
    },
    statusesFitAt: (width: number): boolean => {
      if (statusPlan?.width !== width) {
        statusPlan = { width, fits: toolStatusesFit(catalog.items, width) };
      }
      return statusPlan.fits;
    },
  };
}
