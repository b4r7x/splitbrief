import type { TuiEvent } from '../../types.js';
import type { TaskCompletionMethod } from '../../types.js';
import type { Section } from '../../core/event-sections.js';
import type { DynamicSection } from './viewport-trimming.js';
import { estimateSectionHeight } from './section-heights.js';
import { conversationScrollStore } from '../../stores/conversation-scroll.js';
import { workflowStore } from '../../stores/workflow.js';
import { terminalSizeStore } from '../../stores/terminal-size.js';

interface TaskCompletedSummary {
  index: number;
  title: string;
  method: TaskCompletionMethod;
  retries: number;
  duration: number;
  file?: string;
  reason?: string;
}

export interface UseScrollableFlowResult {
  completedItems: TaskCompletedSummary[];
  allDynamic: DynamicSection[];
  expandedDiffs: Set<number>;
  newEventCount: number;
  scrollOffset: number;
  totalDynamicHeight: number;
  viewportHeight: number;
}

export function useScrollableFlow(events: TuiEvent[], rawHeight: number): UseScrollableFlowResult {
  const height = Math.max(0, rawHeight);
  const rawScrollOffset = conversationScrollStore.use(s => s.scrollOffset);
  const expandedDiffs = conversationScrollStore.use(s => s.expandedDiffs);
  const eventCountAtScroll = conversationScrollStore.use(s => s.eventCountAtScroll);
  const heightAtScroll = conversationScrollStore.use(s => s.heightAtScroll);
  const cols = terminalSizeStore.use(s => s.cols);

  const sections = workflowStore.use(s => s.sections);
  const measuredHeight = conversationScrollStore.use(s => s.measuredContentHeight);

  const newEventCount = rawScrollOffset > 0 ? Math.max(0, events.length - eventCountAtScroll) : 0;

  const completedItems = sections
    .filter((s): s is Section & { type: 'completed-task' } => s.type === 'completed-task')
    .map(s => s.summary);

  const allDynamic = sections.filter((s): s is DynamicSection => s.type !== 'completed-task');

  const estimatedHeight = allDynamic.reduce(
    (sum, s) => sum + estimateSectionHeight(s, expandedDiffs, cols), 0,
  );

  // Use measured height when available (after first render), fall back to estimated
  const totalDynamicHeight = measuredHeight > 0 ? measuredHeight : estimatedHeight;

  // Anchor compensation: when scrolled up and new content arrives, keep viewport stable
  const heightDelta = rawScrollOffset > 0 && heightAtScroll > 0
    ? Math.max(0, totalDynamicHeight - heightAtScroll) : 0;
  // Add 2 rows of headroom for scroll banners that reduce viewport height
  const maxOffset = Math.max(0, totalDynamicHeight - height + 2);
  const scrollOffset = Math.min(rawScrollOffset + heightDelta, maxOffset);

  return { completedItems, allDynamic, expandedDiffs, newEventCount, scrollOffset, totalDynamicHeight, viewportHeight: height };
}
