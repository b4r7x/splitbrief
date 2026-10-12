import { INLINE_LABEL_GAP } from '../../conversation-rows/row-format/label-card.js';
import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { useEffect } from 'react';
import { Box } from 'ink';
import { getScrollWindowState } from '../../layout/scroll-window.js';
import { getWorkflowSidebarWidth } from '../../layout/rect.js';
import { controlsStore } from '../../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { recoveryNoticeStore } from '../../../../stores/workflow/recovery-notice.js';
import { approvalPromptStore } from '../../../../stores/approval-prompt/prompt.js';
import { deriveWorkflowDisplay } from '../../display/workflow-status.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { transcriptTailStore } from '../../../../stores/workflow/transcript-tail.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { formatTaskHeading, tasksStore } from '../../../../stores/workflow/tasks.js';
import { useSections } from '../../../../stores/workflow/actions/sections.js';
import { useStores } from '../../../../stores/use-stores.js';
import type { ConversationRowBlock } from '../../conversation-rows/types.js';
import { computeConversationRowScroll } from '../../conversation-rows/scroll.js';
import { splitConversationViewport } from '../../conversation-rows/viewport.js';
import { queuedBriefs } from '../../conversation-rows/queued-briefs.js';
import { row } from '../../conversation-rows/row-format/rows.js';
import { rowLeadingCells } from '../../conversation-rows/row-markers.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { countNoun, pluralize } from '../../../../utils/pluralize.js';
import { ConversationRowView } from './row-view.js';
import { ConversationTranscriptRows } from './conversation-hover-rows.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import { routeBriefMark } from '../../at-rest.js';

interface ConversationFlowProps {
  height: number;
  conversationWidth: number;
  contentWidth: number;
  onScrollAbove?: ((label: string) => void) | undefined;
  onScrollBelow?: ((label: string) => void) | undefined;
  /** Blocks appended after the run's own events, inside this one scroller. */
  tail?: readonly ConversationRowBlock[] | undefined;
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
  tail,
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
    recovery,
    approval,
  ] = useStores(
    conversationScrollStore,
    streamingOutputStore,
    lifecycleStore,
    tasksStore,
    controlsStore,
    terminalSizeStore,
    recoveryNoticeStore,
    approvalPromptStore,
  );
  const display = deriveWorkflowDisplay({
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    pendingQuestion: controls.inputMode !== 'normal',
    pendingRecovery: recovery.issue !== null,
    pendingApproval: approval.status === 'pending',
  });
  const isRunning = display.animate;
  const restMark = routerStore.use(routeBriefMark);
  const sections = useSections();
  const viewportHeight = Math.max(0, height);
  const cols = conversationWidth;
  const sidebarShowsTasks =
    getWorkflowSidebarWidth({
      cols: terminalSize.cols,
      sidebarVisible: controls.sidebarVisible,
    }) > 0;
  const pendingTasks = queuedBriefs({
    tasks,
    phase: lifecycle.phase,
    sidebarShowsTasks,
    closed: tail !== undefined && tail.length > 0,
  });
  const viewportSplit = splitConversationViewport({
    viewportHeight,
    sections,
    pendingTaskCount: pendingTasks.length,
  });
  // A block too short for every pending brief spends its last row saying how many it left out,
  // unless that row would be its only one: then the heading carries the overflow count.
  const shownPending =
    pendingTasks.length > viewportSplit.queuedRows && viewportSplit.queuedRows > 1
      ? viewportSplit.queuedRows - 1
      : Math.min(viewportSplit.queuedRows, pendingTasks.length);
  const hiddenPending = pendingTasks.length - shownPending;
  const queuedRows = pendingTasks.slice(0, shownPending).map((task) =>
    row({
      key: `queued-${task.id}`,
      text: formatTaskHeading(task),
      tone: 'textDim',
      kind: 'task-header',
    }),
  );
  const transcriptViewportHeight = viewportSplit.transcriptViewportHeight;
  const {
    newEventCount,
    rows,
    scrollOffset,
    totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    activeRowKey,
    activeTaskHeaderKey,
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
    ...(tail !== undefined && { tail }),
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

  // The transcript pane sizes to its rows so a short run does not leave a hole above whatever
  // follows it. The empty-state line is a row too, and a zero-height pane would clip it.
  const showsEmptyState = rows.length === 0;

  // The keyboard measures the transcript from the stores, so what the tail adds has to reach it
  // or `home` and `end` stop at the last event the run wrote.
  const tailRows = (tail ?? []).reduce((sum, block) => sum + block.rowCount, 0);
  const tailUnits = (tail ?? []).reduce((sum, block) => sum + block.renderableUnits, 0);
  useEffect(() => {
    transcriptTailStore.setMetrics({ rowCount: tailRows, renderableUnits: tailUnits });
    return () => transcriptTailStore.setMetrics({ rowCount: 0, renderableUnits: 0 });
  }, [tailRows, tailUnits]);

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
      <Box
        width={conversationWidth}
        height={Math.min(innerHeight, showsEmptyState ? 1 : rows.length)}
        flexDirection="column"
        overflow="hidden"
        flexShrink={0}
      >
        <Box width="100%" flexDirection="column" flexShrink={0}>
          {showsEmptyState && (
            <Box marginLeft={rowLeadingCells('message')}>
              <Text color={t.textDim}>no events yet</Text>
            </Box>
          )}
          <ConversationTranscriptRows
            rows={rows}
            visibleActiveRowKey={visibleActiveRowKey}
            activeTaskHeaderKey={activeTaskHeaderKey}
            restMark={restMark}
          />
        </Box>
      </Box>
      {viewportSplit.queuedRows > 0 && (
        <Box flexDirection="column" width={conversationWidth} flexShrink={0} overflow="hidden">
          {/* One pad row and the heading — the two rows the viewport split charges this block as
              its chrome. A bare run of circles under a stretch of blank rows announces nothing;
              the air belongs above the label and the label belongs against its rows. */}
          <Box height={1} width={conversationWidth} flexShrink={0} />
          <Box
            height={1}
            width={conversationWidth}
            overflow="hidden"
            flexShrink={0}
            marginLeft={rowLeadingCells('message')}
          >
            <Text color={t.textDim}>
              {`Pending${INLINE_LABEL_GAP}${pendingTasks.length}${viewportSplit.queuedRows === 1 && hiddenPending > 0 ? `${SOFT_SEP}+${hiddenPending} more` : ''}`}
            </Text>
          </Box>
          {queuedRows.map((queuedRow) => (
            <Box key={queuedRow.key} height={1} width={conversationWidth} flexShrink={0}>
              <ConversationRowView row={queuedRow} lifecycle="queued" />
            </Box>
          ))}
          {hiddenPending > 0 && viewportSplit.queuedRows > 1 && (
            <Box
              height={1}
              width={conversationWidth}
              overflow="hidden"
              flexShrink={0}
              marginLeft={rowLeadingCells('message')}
            >
              <Text color={t.textDim}>{`+${hiddenPending} more`}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
