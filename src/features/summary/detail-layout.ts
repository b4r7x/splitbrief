import type { Summary } from '../../core/schemas/summary.js';

const SHELL_PADDING_ROWS = 2;
const FOOTER_ROWS = 4;
const BASE_HEADER_ROWS = 1;
const METADATA_MARGIN_ROWS = 1;
const BASE_METADATA_ROWS = 1;
const PROGRESS_MARGIN_ROWS = 1;
const PROGRESS_NON_EMPTY_ROWS = 1;
const PROGRESS_EMPTY_ROWS = 1;
const LEDGER_DIVIDER_ROWS = 2;
const VIEWPORT_SAFETY_ROWS = 1;

interface SummaryDetailLayoutInput {
  terminalRows: number;
  isSmall: boolean;
  summary: Summary;
  implementerSummary: string | null;
  reviewerSummary: string | null;
  routeSummary: string | null;
}

function countHeroSavingsRows(costBreakdown: Summary['costBreakdown'], isSmall: boolean): number {
  if (!costBreakdown) return 0;
  if (costBreakdown.hasSavingsEstimate === false) return 0;
  if (costBreakdown.savingsAmount <= 0) return 0;
  return isSmall ? 2 : 3;
}

function countMetadataRows(
  summary: Summary,
  implementerSummary: string | null,
  reviewerSummary: string | null,
  isSmall: boolean,
): number {
  let childRows = BASE_METADATA_ROWS;
  // The three seat rows render at every width, so they are counted at every width.
  if (summary.plannerTool) childRows += 1;
  if (implementerSummary) childRows += 1;
  if (reviewerSummary) childRows += 1;
  if (summary.briefQuality) childRows += 1;
  if (summary.driftSummary) childRows += 1;
  if (summary.chainDriftSummary) childRows += 1;
  if (!summary.costBreakdown && summary.estimatedCostSavings !== 'unavailable') childRows += 1;
  const gapRows = isSmall ? 0 : Math.max(0, childRows - 1);
  return METADATA_MARGIN_ROWS + childRows + gapRows;
}

function countProgressRows(summary: Summary): number {
  const bodyRows = summary.totalTasks === 0 ? PROGRESS_EMPTY_ROWS : PROGRESS_NON_EMPTY_ROWS;
  return PROGRESS_MARGIN_ROWS + bodyRows + (summary.totalTasks === 0 && summary.failed > 0 ? 1 : 0);
}

function countHeaderRows(isSmall: boolean): number {
  return BASE_HEADER_ROWS + (isSmall ? 0 : 1);
}

function countBodyChromeRows(input: SummaryDetailLayoutInput): number {
  const { isSmall, summary, implementerSummary, reviewerSummary } = input;
  let chrome =
    countHeaderRows(isSmall) +
    countProgressRows(summary) +
    countMetadataRows(summary, implementerSummary, reviewerSummary, isSmall);
  chrome += countHeroSavingsRows(summary.costBreakdown, isSmall);
  chrome += LEDGER_DIVIDER_ROWS;
  return chrome;
}

export function getSummaryDetailViewportHeight(input: SummaryDetailLayoutInput): number {
  const bodyRows = input.terminalRows - SHELL_PADDING_ROWS - FOOTER_ROWS;
  const headerChrome = countBodyChromeRows(input);
  const remaining = bodyRows - headerChrome - VIEWPORT_SAFETY_ROWS;
  return Math.max(1, remaining);
}
