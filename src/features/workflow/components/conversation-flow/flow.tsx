import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { glyph } from '../../../../lib/glyphs.js';
import { TaskSummary } from '../task-summary.js';
import { getScrollWindowState } from '../../layout/scroll-window.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../../stores/workflow/tasks.js';
import { useSections } from '../../../../stores/workflow/actions/sections.js';
import { useStores } from '../../../../stores/use-stores.js';
import { computeConversationRowScroll } from '../../conversation-rows/scroll.js';
import { splitConversationViewport } from '../../conversation-rows/viewport.js';
import { row } from '../../conversation-rows/row-format/rows.js';
import { SOFT_SEP } from '../../../../components/separators.js';
import { countNoun, pluralize } from '../../../../utils/pluralize.js';
import { ConversationRowView } from './row-view.js';
import {
  CompletedTaskSummariesWithHover,
  ConversationTranscriptRows,
} from './conversation-hover-rows.js';

interface ConversationFlowProps {
  height: number;
  conversationWidth: number;
  contentWidth: number;
  onScrollAbove?: ((label: string) => void) | undefined;
  onScrollBelow?: ((label: string) => void) | undefined;
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
  onScrollBelow,
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
    tasks,
  ] = useStores(conversationScrollStore, streamingOutputStore, lifecycleStore, tasksStore);
  const isRunning = lifecycle.status === 'running';
  const sections = useSections();
  const viewportHeight = Math.max(0, height);
  const cols = conversationWidth;
  const completedItems = sections.flatMap((section) =>
    section.type === 'completed-task' ? [section.summary] : [],
  );
  const pendingTasks = tasks.tasks.filter((task) => task.status === 'pending');
  const viewportSplit = splitConversationViewport({
    viewportHeight,
    sections,
    pendingTaskCount: pendingTasks.length,
  });
  const queuedRows = tasks.tasks
    .filter((task) => task.status === 'pending')
    .slice(0, viewportSplit.queuedRows)
    .map((task) =>
      row({ key: `queued-${task.id}`, text: task.title, tone: 'textDim', kind: 'task-header' }),
    );
  const transcriptViewportHeight = viewportSplit.transcriptViewportHeight;
  const completedRows = viewportSplit.completedRows;
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
    viewportHeight: transcriptViewportHeight,
    rawScrollOffset,
    renderableCountAtScroll,
    heightAtScroll,
    streaming,
  });

  const visibleActiveRowKey =
    isRunning && activeRowKey !== null && rows.some((candidate) => candidate.key === activeRowKey)
      ? activeRowKey
      : null;
  const windowState = getScrollWindowState({
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    scrollOffset,
  });
  const { above, below } = computeScrollBannerLabel(windowState.linesAbove, windowState.linesBelow);
  const { innerHeight } = windowState;
  const newEventsLabel =
    newEventCount > 0 && scrollOffset > 0
      ? `↓ ${newEventCount} new ${pluralize(newEventCount, 'event')}`
      : '';
  const belowLabel = [below, newEventsLabel].filter((part) => part !== '').join(SOFT_SEP);

  const stickyLeadingLines = viewportSplit.stickyLeadingRows;

  useEffect(() => {
    onScrollAbove?.(above);
    return () => onScrollAbove?.('');
  }, [above, onScrollAbove]);

  useEffect(() => {
    onScrollBelow?.(belowLabel);
    return () => onScrollBelow?.('');
  }, [belowLabel, onScrollBelow]);

  return (
    <Box
      flexDirection="column"
      height={height}
      width={contentWidth}
      overflow="hidden"
      flexShrink={0}
    >
      {visibleCompletedItems.length > 0 ? (
        <CompletedTaskSummariesWithHover
          conversationWidth={conversationWidth}
          summaryCount={visibleCompletedItems.length}
        >
          {(focusedSummaryIndex) => (
            <>
              <Box height={1} width={conversationWidth} overflow="hidden" flexShrink={0}>
                <Text color={t.textDim}>{`${glyph('completed')} completed`}</Text>
              </Box>
              {visibleCompletedItems.map((item, position) => (
                <Box
                  key={`completed-${item.index}`}
                  height={1}
                  width={conversationWidth}
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
                    focused={focusedSummaryIndex === position}
                  />
                </Box>
              ))}
              <Box height={1} width={conversationWidth} flexShrink={0} />
            </>
          )}
        </CompletedTaskSummariesWithHover>
      ) : null}
      <Box
        width={conversationWidth}
        height={innerHeight}
        flexDirection="column"
        overflow="hidden"
        flexShrink={0}
      >
        <Box width="100%" flexDirection="column" flexShrink={0}>
          {rows.length === 0 && completedItems.length === 0 && (
            <Text color={t.textDim}>no events yet</Text>
          )}
          <ConversationTranscriptRows
            rows={rows}
            stickyLeadingLines={stickyLeadingLines}
            visibleActiveRowKey={visibleActiveRowKey}
          />
        </Box>
      </Box>
      {queuedRows.length > 0 && (
        <Box flexDirection="column" width={conversationWidth} flexShrink={0} overflow="hidden">
          {queuedRows.map((queuedRow) => (
            <Box key={queuedRow.key} height={1} width={conversationWidth} flexShrink={0}>
              <ConversationRowView row={queuedRow} lifecycle="queued" />
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
