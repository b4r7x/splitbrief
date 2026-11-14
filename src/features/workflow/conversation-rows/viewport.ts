import { formatTaskHeading } from '../../../core/run-view/brief-labels.js';
import type { WorkflowTask } from '../../../core/run-view/briefs.js';
import { isSettledSection, type Section } from '../../../core/sections/types.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { getScrollWindowState } from '../layout/scroll-window.js';
import { row } from './row-format/rows.js';
import { computeConversationRowScroll } from './scroll.js';
import type { ConversationRow, ConversationRowScrollInputs } from './types.js';

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

export interface ConversationViewportWindow {
  rows: ConversationRow[];
  showsEmptyState: boolean;
  transcriptHeight: number;
  visibleActiveRowKey: string | null;
  activeTaskHeaderKey: string | null;
  above: string;
  below: string;
  /** The pending block: its row budget, the brief rows it paints, and the briefs it leaves out. */
  queued: { rows: number; shown: ConversationRow[]; hidden: number };
}

export function conversationViewportWindow(
  input: Omit<ConversationRowScrollInputs, 'viewportHeight'> & {
    height: number;
    pendingTasks: readonly WorkflowTask[];
    isRunning: boolean;
  },
): ConversationViewportWindow {
  const { pendingTasks } = input;
  const viewportSplit = splitConversationViewport({
    viewportHeight: input.height,
    sections: input.sections,
    pendingTaskCount: pendingTasks.length,
  });
  // A block too short for every pending brief spends its last row saying how many it left out,
  // unless that row would be its only one: then the heading carries the overflow count.
  const shownPending =
    pendingTasks.length > viewportSplit.queuedRows && viewportSplit.queuedRows > 1
      ? viewportSplit.queuedRows - 1
      : Math.min(viewportSplit.queuedRows, pendingTasks.length);
  const {
    newEventCount,
    rows,
    scrollOffset,
    totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    activeRowKey,
    activeTaskHeaderKey,
  } = computeConversationRowScroll({
    ...input,
    viewportHeight: viewportSplit.transcriptViewportHeight,
  });
  const windowState = getScrollWindowState({
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    scrollOffset,
  });
  const above =
    windowState.linesAbove > 0 ? `${countNoun(windowState.linesAbove, 'line')} above` : '';
  const below = [
    windowState.linesBelow > 0 ? `${countNoun(windowState.linesBelow, 'line')} below` : '',
    newEventCount > 0 && scrollOffset > 0
      ? `↓ ${newEventCount} new ${pluralize(newEventCount, 'event')}`
      : '',
  ]
    .filter((part) => part !== '')
    .join(SOFT_SEP);
  // The transcript pane sizes to its rows so a short run does not leave a hole above whatever
  // follows it. The empty-state line is a row too, and a zero-height pane would clip it.
  const showsEmptyState = rows.length === 0;
  return {
    rows,
    showsEmptyState,
    transcriptHeight: Math.min(windowState.innerHeight, showsEmptyState ? 1 : rows.length),
    visibleActiveRowKey:
      input.isRunning &&
      activeRowKey !== null &&
      rows.some((candidate) => candidate.key === activeRowKey)
        ? activeRowKey
        : null,
    activeTaskHeaderKey,
    above,
    below,
    queued: {
      rows: viewportSplit.queuedRows,
      shown: pendingTasks.slice(0, shownPending).map((task) =>
        row({
          key: `queued-${task.id}`,
          text: formatTaskHeading(task),
          tone: 'textDim',
          kind: 'task-header',
        }),
      ),
      hidden: pendingTasks.length - shownPending,
    },
  };
}
