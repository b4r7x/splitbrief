import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { TaskSummary } from '../task-summary.js';
import { getScrollWindowState } from '../../layout/scroll-window.js';
import { getWorkflowSidebarWidth } from '../../layout/rect.js';
import { controlsStore } from '../../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { selectTaskListView, tasksStore } from '../../../../stores/workflow/tasks.js';
import type { TaskListView } from '../../../../stores/workflow/tasks.js';
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

// Without a sidebar this header is the only place the transcript states how far the run has got, so
// it carries the counts rather than the bare word "completed". Bare of any marker, like the
// sidebar's own headings: a heading whose first character is a letter, above rows whose first
// character is a symbol, differs in kind rather than in shape, and no glyph tier can collapse that.
function taskListLabel(view: TaskListView): string {
  return view.total > 0 ? `Completed ${view.settled}/${view.total}` : 'Completed';
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
    controls,
    terminalSize,
  ] = useStores(
    conversationScrollStore,
    streamingOutputStore,
    lifecycleStore,
    tasksStore,
    controlsStore,
    terminalSizeStore,
  );
  const isRunning = lifecycle.status === 'running';
  const sections = useSections();
  const viewportHeight = Math.max(0, height);
  const cols = conversationWidth;
  const completedItems = sections.flatMap((section) =>
    section.type === 'completed-task' ? [section.summary] : [],
  );
  const taskListView = selectTaskListView(tasks);
  // The sidebar is the persistent list and the transcript is the narrative, so the queued block
  // stands down while the sidebar renders rather than printing the same pending titles twice, side
  // by side. Below the sidebar's column breakpoint it is the only place pending work appears.
  const sidebarShowsTasks =
    getWorkflowSidebarWidth({
      cols: terminalSize.cols,
      sidebarVisible: controls.sidebarVisible,
    }) > 0;
  const pendingTasks = sidebarShowsTasks
    ? []
    : tasks.tasks.filter((task) => task.status === 'pending');
  const viewportSplit = splitConversationViewport({
    viewportHeight,
    sections,
    pendingTaskCount: pendingTasks.length,
  });
  const queuedRows = pendingTasks
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
  // The transcript pane sizes to its rows so a short run does not leave a hole above whatever
  // follows it. The empty-state line is a row too, and a zero-height pane would clip it.
  const showsEmptyState = rows.length === 0 && completedItems.length === 0;

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
                <Text color={t.textDim}>{taskListLabel(taskListView)}</Text>
              </Box>
              {visibleCompletedItems.map((item, position) => (
                <Box
                  key={`completed-${item.index}`}
                  height={1}
                  width={conversationWidth}
                  flexShrink={0}
                >
                  <TaskSummary
                    width={conversationWidth}
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
        height={Math.min(innerHeight, showsEmptyState ? 1 : rows.length)}
        flexDirection="column"
        overflow="hidden"
        flexShrink={0}
      >
        <Box width="100%" flexDirection="column" flexShrink={0}>
          {showsEmptyState && <Text color={t.textDim}>no events yet</Text>}
          <ConversationTranscriptRows
            rows={rows}
            stickyLeadingLines={stickyLeadingLines}
            visibleActiveRowKey={visibleActiveRowKey}
          />
        </Box>
      </Box>
      {queuedRows.length > 0 && (
        <Box flexDirection="column" width={conversationWidth} flexShrink={0} overflow="hidden">
          {/* One pad row and the heading — the two rows the viewport split charges this block as
              its chrome. A bare run of circles under a stretch of blank rows announces nothing;
              the air belongs above the label and the label belongs against its rows. */}
          <Box height={1} width={conversationWidth} flexShrink={0} />
          <Box height={1} width={conversationWidth} overflow="hidden" flexShrink={0}>
            <Text color={t.textDim}>{`Queued ${pendingTasks.length}`}</Text>
          </Box>
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
