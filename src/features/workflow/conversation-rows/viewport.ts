import { getCompletedTaskSummaryRows } from '../../../core/sections/completed-task-summary-rows.js';
import type { Section } from '../../../core/sections/event-sections.js';

export interface ConversationViewportSplit {
  completedRows: number;
  queuedRows: number;
  stickyLeadingRows: number;
  transcriptViewportHeight: number;
}

export function splitConversationViewport(input: {
  viewportHeight: number;
  sections: Section[];
  pendingTaskCount: number;
}): ConversationViewportSplit {
  const viewportHeight = Math.max(0, input.viewportHeight);
  const completedCount = input.sections.filter(
    (section) => section.type === 'completed-task',
  ).length;
  const hasSectionContent = input.sections.some(
    (section) => section.type === 'completed-task' || section.items.length > 0,
  );
  const completedChromeRows = completedCount > 0 && viewportHeight >= 3 ? 2 : 0;
  const queuedBudget = hasSectionContent
    ? Math.max(0, viewportHeight - completedChromeRows - 1)
    : 0;
  const queuedRows = Math.min(input.pendingTaskCount, queuedBudget);
  const transcriptViewportHeight = Math.max(0, viewportHeight - completedChromeRows - queuedRows);
  const completedRows = getCompletedTaskSummaryRows(input.sections, transcriptViewportHeight);
  return {
    completedRows,
    queuedRows,
    stickyLeadingRows: completedRows > 0 ? completedRows + 2 : 0,
    transcriptViewportHeight,
  };
}
