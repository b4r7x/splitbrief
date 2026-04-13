import type { TuiEvent } from '../../types.js';
import type { TaskCompletionMethod } from '../../types.js';
import type { Section } from '../../core/event-sections.js';
import { trimSectionsToViewport, type DynamicSection } from './viewport-trimming.js';
import { conversationScrollStore } from '../../stores/conversation-scroll.js';
import { workflowStore } from '../../stores/workflow.js';

export interface TaskCompletedSummary {
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
  visibleDynamic: DynamicSection[];
  expandedDiffs: Set<number>;
  newEventCount: number;
}

export function useScrollableFlow(events: TuiEvent[], rawHeight: number): UseScrollableFlowResult {
  const height = Math.max(0, rawHeight);
  const scrollOffset = conversationScrollStore.use(s => s.scrollOffset);
  const expandedDiffs = conversationScrollStore.use(s => s.expandedDiffs);
  const eventCountAtScroll = conversationScrollStore.use(s => s.eventCountAtScroll);

  const sections = workflowStore.use(s => s.sections);

  const newEventCount = scrollOffset > 0 ? Math.max(0, events.length - eventCountAtScroll) : 0;

  const completedItems = sections
    .filter((s): s is Section & { type: 'completed-task' } => s.type === 'completed-task')
    .map(s => s.summary);

  const dynamicSections = sections.filter((s): s is DynamicSection => s.type !== 'completed-task');

  const { visibleSections: visibleDynamic } = trimSectionsToViewport(
    dynamicSections, scrollOffset, height, expandedDiffs,
  );

  return { completedItems, visibleDynamic, expandedDiffs, newEventCount };
}
