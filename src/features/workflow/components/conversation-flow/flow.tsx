import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { Divider } from '../divider.js';
import { TaskSummary } from '../task-summary.js';
import { getScrollWindowState } from '../../layout/scroll-window.js';
import { getCompletedTaskSummaryRows } from '../../../../core/sections/completed-task-summary-rows.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { useSections } from '../../../../stores/workflow/actions.js';
import { useStores } from '../../../../stores/use-stores.js';
import { computeConversationRowScroll } from '../../conversation-rows/scroll.js';
import { countNoun, pluralize } from '../../../../utils/pluralize.js';
import { ConversationRowView } from './row-view.js';

interface ConversationFlowProps {
  height: number;
  width: number;
}

function computeScrollBannerLabel(
  linesAbove: number,
  linesBelow: number,
): { above: string; below: string } {
  return {
    above: linesAbove > 0 ? `${countNoun(linesAbove, 'line')} above` : '',
    below: linesBelow > 0 ? `${countNoun(linesBelow, 'line')} below` : '',
  };
}

export function ConversationFlow({ height, width }: ConversationFlowProps) {
  const t = useTheme();
  const [
    {
      scrollOffset: rawScrollOffset,
      expandedDiffs,
      expandedActivityBatches,
      renderableCountAtScroll,
      heightAtScroll,
    },
    streaming,
  ] = useStores(conversationScrollStore, streamingOutputStore);
  const sections = useSections();
  const viewportHeight = Math.max(0, height);
  const cols = width;
  const completedItems = sections.flatMap((section) =>
    section.type === 'completed-task' ? [section.summary] : [],
  );
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
    expandedActivityBatches,
    cols,
    viewportHeight,
    rawScrollOffset,
    renderableCountAtScroll,
    heightAtScroll,
    streaming,
  });

  const hasNewEvents = newEventCount > 0;
  const windowState = getScrollWindowState({
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    scrollOffset,
    hasNewEvents,
  });
  const { above, below } = computeScrollBannerLabel(windowState.linesAbove, windowState.linesBelow);
  const { newEventRows, innerHeight } = windowState;

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden" flexShrink={0}>
      {visibleCompletedItems.map((item) => (
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
      {above !== '' && <Divider width={width} label={above} tone="textDim" />}
      <Box height={innerHeight} overflow="hidden" flexDirection="column" flexShrink={0}>
        <Box width="100%" flexDirection="column" flexShrink={0}>
          {rows.length === 0 && completedItems.length === 0 && (
            <Text color={t.textDim}>No events yet</Text>
          )}
          {rows.map((row) => (
            <ConversationRowView key={row.key} row={row} />
          ))}
        </Box>
      </Box>
      {below !== '' && <Divider width={width} label={below} tone="textDim" />}
      {newEventRows > 0 && (
        <Divider
          width={width}
          label={`↓ ${newEventCount} new ${pluralize(newEventCount, 'event')}`}
          tone="textDim"
        />
      )}
    </Box>
  );
}
