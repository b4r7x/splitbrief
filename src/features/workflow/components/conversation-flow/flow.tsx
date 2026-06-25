import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { Divider } from '../divider.js';
import { TaskSummary } from '../task-summary.js';
import { getScrollWindowState } from '../../layout/scroll-window.js';
import { getCompletedTaskSummaryRows } from '../../../../core/sections/completed-task-summary-rows.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { useSections } from '../../../../stores/workflow/actions.js';
import { useStores } from '../../../../stores/use-stores.js';
import { computeConversationRowScroll } from '../../conversation-rows/scroll.js';
import { countNoun, pluralize } from '../../../../utils/pluralize.js';
import { ConversationRowView } from './row-view.js';

interface ConversationFlowProps {
  height: number;
  conversationWidth: number;
  contentWidth: number;
  onScrollAbove?: ((label: string) => void) | undefined;
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

export function ConversationFlow({
  height,
  conversationWidth,
  contentWidth,
  onScrollAbove,
}: ConversationFlowProps) {
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
    lifecycle,
  ] = useStores(conversationScrollStore, streamingOutputStore, lifecycleStore);
  const isRunning = lifecycle.status === 'running';
  const sections = useSections();
  const viewportHeight = Math.max(0, height);
  const cols = conversationWidth;
  const fullWidth = contentWidth;
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
    activeRowKey,
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
  const visibleActiveRowKey =
    isRunning && activeRowKey !== null && rows.some((row) => row.key === activeRowKey)
      ? activeRowKey
      : null;
  const windowState = getScrollWindowState({
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    scrollOffset,
    hasNewEvents,
  });
  const { above, below } = computeScrollBannerLabel(windowState.linesAbove, windowState.linesBelow);
  const { newEventRows, innerHeight } = windowState;

  useEffect(() => {
    onScrollAbove?.(above);
    return () => onScrollAbove?.('');
  }, [above, onScrollAbove]);

  return (
    <Box
      flexDirection="column"
      height={height}
      width={contentWidth}
      overflow="hidden"
      flexShrink={0}
    >
      <Box flexDirection="column" width={conversationWidth} flexShrink={0} overflow="hidden">
        {visibleCompletedItems.map((item) => (
          <Box
            key={`completed-${item.index}`}
            height={1}
            width={conversationWidth}
            overflow="hidden"
            flexShrink={0}
          >
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
      </Box>
      <Box
        width={conversationWidth}
        height={innerHeight}
        flexDirection="column"
        overflow="hidden"
        flexShrink={0}
      >
        <Box width="100%" flexDirection="column" flexShrink={0}>
          {rows.length === 0 && completedItems.length === 0 && (
            <Text color={t.textDim}>No events yet</Text>
          )}
          {rows.map((row) => (
            <ConversationRowView
              key={row.key}
              row={row}
              expandedActivityBatches={expandedActivityBatches}
              active={row.key === visibleActiveRowKey}
            />
          ))}
        </Box>
      </Box>
      {below !== '' && <Divider width={fullWidth} label={below} tone="textDim" />}
      {newEventRows > 0 && (
        <Box height={1} width={conversationWidth} overflow="hidden" flexShrink={0}>
          <Divider
            width={conversationWidth}
            label={`↓ ${newEventCount} new ${pluralize(newEventCount, 'event')}`}
            tone="textDim"
          />
        </Box>
      )}
    </Box>
  );
}
