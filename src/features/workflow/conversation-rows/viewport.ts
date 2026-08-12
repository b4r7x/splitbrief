import { getCompletedTaskSummaryRows } from '../../../core/sections/completed-task-summary-rows.js';
import type { Section } from '../../../core/sections/event-sections.js';

export interface ConversationViewportSplit {
  completedRows: number;
  queuedRows: number;
  stickyLeadingRows: number;
  transcriptViewportHeight: number;
}

const BOOKEND_CHROME_ROWS = 2;
const BOOKEND_MAX_ROWS = 5;

function bookendBudget(allowance: number, activeBookends: number): number {
  if (activeBookends === 0) return 0;
  const painted = Math.min(BOOKEND_MAX_ROWS, Math.floor(allowance / activeBookends));
  return Math.max(0, painted - BOOKEND_CHROME_ROWS);
}

export function splitConversationViewport(input: {
  viewportHeight: number;
  sections: Section[];
  pendingTaskCount: number;
}): ConversationViewportSplit {
  const viewportHeight = Math.max(0, input.viewportHeight);
  const hasSectionContent = input.sections.some(
    (section) => section.type === 'completed-task' || section.items.length > 0,
  );
  const completedDemand = getCompletedTaskSummaryRows(input.sections, viewportHeight);
  const queuedDemand = hasSectionContent ? input.pendingTaskCount : 0;
  const hasLiveRows = input.sections.some(
    (section) => section.type !== 'completed-task' && section.items.length > 0,
  );
  const budget = bookendBudget(
    hasLiveRows ? Math.floor(viewportHeight / 2) : viewportHeight,
    (completedDemand > 0 ? 1 : 0) + (queuedDemand > 0 ? 1 : 0),
  );
  const queuedRows = Math.min(queuedDemand, budget);
  const completedRows = Math.min(completedDemand, budget);
  const completedChromeRows = completedRows > 0 ? BOOKEND_CHROME_ROWS : 0;
  const queuedChromeRows = queuedRows > 0 ? BOOKEND_CHROME_ROWS : 0;
  return {
    completedRows,
    queuedRows,
    stickyLeadingRows: completedRows > 0 ? completedRows + BOOKEND_CHROME_ROWS : 0,
    transcriptViewportHeight: Math.max(
      0,
      viewportHeight - completedRows - completedChromeRows - queuedRows - queuedChromeRows,
    ),
  };
}
