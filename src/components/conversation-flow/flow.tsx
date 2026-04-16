import { Box, Text, Static } from 'ink';
import { appendFileSync } from 'fs';
import type { TuiEvent } from '../../types.js';
import { useTheme } from '../../ui/theme.js';
import { EventCard } from '../event-cards/index.js';
import { TaskSummary } from '../workflow/task-summary.js';
import { useScrollableFlow } from './use-scrollable-flow.js';
import { computeScrollBannerText } from '../../utils/scroll-banner.js';
import { MeasureBox } from '../../ui/input/measure-box.js';
import { conversationScrollStore } from '../../stores/conversation-scroll.js';

interface ConversationFlowProps {
  events: TuiEvent[];
  height: number;
  width?: number;
}

/** Events rendered in chrome (L1/L2), not in the scroll region */
const CHROME_EVENT_TYPES = new Set<TuiEvent['type']>(['planner-status', 'workflow-config']);

export function ConversationFlow({ events, height, width }: ConversationFlowProps) {
  const t = useTheme();
  const { completedItems, allDynamic, expandedDiffs, newEventCount, scrollOffset, totalDynamicHeight, viewportHeight } =
    useScrollableFlow(events, height);

  const { above, below } = computeScrollBannerText(scrollOffset, totalDynamicHeight, viewportHeight);
  const bannerRows = (above ? 1 : 0) + (below ? 1 : 0);
  const innerHeight = Math.max(0, viewportHeight - bannerRows);

  // Content shift model (two distinct cases):
  // 1. Short content (fits viewport): spacer pushes content to bottom, no marginTop
  // 2. Tall content (overflows): negative marginTop scrolls, no spacer
  // scrollOffset=0 means "at bottom" (newest visible)
  const hasOverflow = totalDynamicHeight > innerHeight;
  const spacerHeight = hasOverflow ? 0 : Math.max(0, innerHeight - totalDynamicHeight);
  // For overflow: scroll position is (totalDynamicHeight - innerHeight - scrollOffset) from top
  // Clamp to non-positive (can't scroll past content start)
  const scrollMargin = hasOverflow ? -Math.max(0, totalDynamicHeight - innerHeight - scrollOffset) : 0;

  // Collect renderable events (same logic as rendering)
  const allRenderable = allDynamic.flatMap((section) =>
    section.items
      .map((event, i) => ({ event, globalIndex: section.startIndex + i }))
      .filter(({ event }) => !CHROME_EVENT_TYPES.has(event.type))
  );

  // DEBUG: Log to file
  appendFileSync('/tmp/scroll-debug.log', JSON.stringify({
    ts: Date.now(),
    height,
    viewportHeight,
    bannerRows,
    innerHeight,
    totalDynamicHeight,
    scrollOffset,
    hasOverflow,
    spacerHeight,
    scrollMargin,
    above,
    below,
    eventCount: events.length,
    renderableCount: allRenderable.length,
    renderableTypes: allRenderable.map(r => r.event.type),
  }) + '\n');

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Static items={completedItems}>
        {(item) => (
          <TaskSummary
            key={`completed-${item.index}`}
            index={item.index}
            title={item.title}
            method={item.method}
            retries={item.retries}
            duration={item.duration}
            file={item.file}
            reason={item.reason}
          />
        )}
      </Static>
      {above !== '' && (
        <Box justifyContent="center" height={1} flexShrink={0} width="100%">
          <Text color={t.textDim}>{above}</Text>
        </Box>
      )}
      <Box height={innerHeight} overflow="hidden" flexDirection="column" flexShrink={0}>
        {spacerHeight > 0 && <Box height={spacerHeight} flexShrink={0} />}
        <Box width="100%" flexDirection="column" marginTop={scrollMargin} flexShrink={0}>
          <MeasureBox onHeightChange={conversationScrollStore.setMeasuredHeight}>
            {allDynamic.length === 0 && completedItems.length === 0 && (
              <Text color={t.textDim}>No events yet</Text>
            )}
            {/* Render with spacer only between events (not after last) */}
            {allRenderable.map(({ event, globalIndex }, renderIndex) => (
              <Box key={globalIndex} flexShrink={0}>
                <EventCard
                  event={event}
                  diffExpanded={expandedDiffs.has(globalIndex)}
                />
                {renderIndex < allRenderable.length - 1 && <Box height={1} flexShrink={0} />}
              </Box>
            ))}
          </MeasureBox>
        </Box>
      </Box>
      {below !== '' && (
        <Box justifyContent="center" height={1} flexShrink={0} width="100%">
          <Text color={t.textDim}>{below}</Text>
        </Box>
      )}
      {newEventCount > 0 && scrollOffset > 0 && (
        <Box justifyContent="center">
          <Text color={t.textDim}>{`─── ↓ ${newEventCount} new event${newEventCount === 1 ? '' : 's'} ───`}</Text>
        </Box>
      )}
    </Box>
  );
}
