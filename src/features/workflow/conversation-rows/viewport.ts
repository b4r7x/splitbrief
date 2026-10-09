import { isSettledSection, type Section } from '../../../core/sections/event-sections.js';

export interface ConversationViewportSplit {
  queuedRows: number;
  transcriptViewportHeight: number;
}

const BOOKEND_CHROME_ROWS = 2;
const BOOKEND_MAX_ROWS = 5;

function queuedBudget(allowance: number): number {
  const painted = Math.min(BOOKEND_MAX_ROWS, allowance);
  return Math.max(0, painted - BOOKEND_CHROME_ROWS);
}

export function splitConversationViewport(input: {
  viewportHeight: number;
  sections: Section[];
  pendingTaskCount: number;
}): ConversationViewportSplit {
  const viewportHeight = Math.max(0, input.viewportHeight);
  const hasSectionContent = input.sections.some(
    (section) => isSettledSection(section) || section.items.length > 0,
  );
  const queuedDemand = hasSectionContent ? input.pendingTaskCount : 0;
  const hasLiveRows = input.sections.some(
    (section) => !isSettledSection(section) && section.items.length > 0,
  );
  const budget =
    queuedDemand > 0
      ? queuedBudget(hasLiveRows ? Math.floor(viewportHeight / 2) : viewportHeight)
      : 0;
  const queuedRows = Math.min(queuedDemand, budget);
  const queuedChromeRows = queuedRows > 0 ? BOOKEND_CHROME_ROWS : 0;
  return {
    queuedRows,
    transcriptViewportHeight: Math.max(0, viewportHeight - queuedRows - queuedChromeRows),
  };
}
