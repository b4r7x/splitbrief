import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { TaskSummary } from '../task-summary.js';
import { getScrollWindowState } from '../../../../core/layout/scroll-window.js';
import { getCompletedTaskSummaryRows } from '../../../../core/layout/completed-task-summary-rows.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { useStores } from '../../../../stores/use-stores.js';
import { computeConversationRowScroll } from '../../conversation-rows/scroll.js';
import type { Section } from '../../../../core/layout/event-sections.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { ConversationRowView } from './conversation-row-view.js';

interface ConversationFlowProps {
  sections: Section<EngineEvent>[];
  height: number;
  width: number;
}

function computeScrollBannerText(
  linesAbove: number,
  linesBelow: number,
): { above: string; below: string } {
  return {
    above: linesAbove > 0 ? `─── ${linesAbove} line${linesAbove === 1 ? '' : 's'} above ───` : '',
    below: linesBelow > 0 ? `─── ${linesBelow} line${linesBelow === 1 ? '' : 's'} below ───` : '',
  };
}

export function ConversationFlow({ sections, height, width }: ConversationFlowProps) {
  const t = useTheme();
  const [{
    scrollOffset: rawScrollOffset,
    expandedDiffs,
    renderableCountAtScroll,
    heightAtScroll,
  }, streaming] = useStores(conversationScrollStore, streamingOutputStore);
  const viewportHeight = Math.max(0, height);
  const cols = width;
  const completedItems = sections
    .filter((section): section is Section & { type: 'completed-task' } => section.type === 'completed-task')
    .map(section => section.summary);
  const completedRows = getCompletedTaskSummaryRows(sections, viewportHeight);
  const visibleCompletedItems = completedRows > 0 ? completedItems.slice(-completedRows) : [];
  const {
    newEventCount,
    rows,
    scrollOffset,
    totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
  } = computeConversationRowScroll({
    sections,
    expandedDiffs,
    cols,
    viewportHeight,
    rawScrollOffset,
    renderableCountAtScroll,
    heightAtScroll,
    streaming,
  });

  const hasNewEvents = newEventCount > 0;
  const windowState = getScrollWindowState(
    totalDynamicHeight,
    scrollViewportHeight,
    scrollOffset,
    hasNewEvents,
  );
  const { above, below } = computeScrollBannerText(windowState.linesAbove, windowState.linesBelow);
  const { newEventRows, innerHeight } = windowState;
  const visibleRows = rows.slice(windowState.windowStart, windowState.windowEnd);

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden" flexShrink={0}>
      {visibleCompletedItems.map(item => (
        <Box key={`completed-${item.index}`} height={1} overflow="hidden" flexShrink={0}>
          <TaskSummary
            index={item.index}
            title={item.title}
            method={item.method}
            retries={item.retries}
            duration={item.duration}
            file={item.file}
            reason={item.reason}
          />
        </Box>
      ))}
      {above !== '' && (
        <Box justifyContent="center" height={1} flexShrink={0} width="100%">
          <Text color={t.textDim}>{above}</Text>
        </Box>
      )}
      <Box height={innerHeight} overflow="hidden" flexDirection="column" flexShrink={0}>
        <Box width="100%" flexDirection="column" flexShrink={0}>
          {rows.length === 0 && completedItems.length === 0 && (
            <Text color={t.textDim}>No events yet</Text>
          )}
          {visibleRows.map(row => (
            <ConversationRowView key={row.key} row={row} />
          ))}
        </Box>
      </Box>
      {below !== '' && (
        <Box justifyContent="center" height={1} flexShrink={0} width="100%">
          <Text color={t.textDim}>{below}</Text>
        </Box>
      )}
      {newEventRows > 0 && (
        <Box justifyContent="center" height={1} flexShrink={0}>
          <Text color={t.textDim}>{`─── ↓ ${newEventCount} new event${newEventCount === 1 ? '' : 's'} ───`}</Text>
        </Box>
      )}
    </Box>
  );
}
