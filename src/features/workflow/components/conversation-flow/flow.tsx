import { INLINE_LABEL_GAP } from '../../conversation-rows/row-format/label-card.js';
import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { useEffect } from 'react';
import { Box } from 'ink';
import { getWorkflowSidebarWidth } from '../../layout/rect.js';
import { controlsStore } from '../../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { approvalPromptStore } from '../../../../stores/prompts/approval.js';
import { deriveWorkflowDisplay } from '../../display/workflow-status.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../../../../stores/workflow/run-view.js';
import { useSections } from '../../../../stores/workflow/actions/sections.js';
import { useStores } from '../../../../stores/use-stores.js';
import type { ConversationRowBlock } from '../../conversation-rows/types.js';
import { publishTranscriptTail } from '../../conversation-rows/transcript-tail.js';
import { conversationViewportWindow } from '../../conversation-rows/viewport.js';
import { queuedBriefs } from '../../conversation-rows/queued-briefs.js';
import { rowLeadingCells } from '../../conversation-rows/row-format/markers.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { ConversationRowView } from './row-view.js';
import { ConversationTranscriptRows } from './hover-rows.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import { routeBriefMark, routeClosedAtRest } from '../../at-rest.js';

interface ConversationFlowProps {
  height: number;
  conversationWidth: number;
  contentWidth: number;
  onScrollAbove?: ((label: string) => void) | undefined;
  onScrollBelow?: ((label: string) => void) | undefined;
  /** Blocks appended after the run's own events, inside this one scroller. */
  tail?: readonly ConversationRowBlock[] | undefined;
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
    controls,
    terminalSize,
    approval,
    runView,
  ] = useStores(
    conversationScrollStore,
    streamingOutputStore,
    lifecycleStore,
    controlsStore,
    terminalSizeStore,
    approvalPromptStore,
    runViewStore,
  );
  const display = deriveWorkflowDisplay({
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    pendingQuestion: controls.inputMode !== 'normal',
    pendingRecovery: runView.halt !== null,
    pendingApproval: approval.status === 'pending',
  });
  const isRunning = display.animate;
  const restMark = routerStore.use(routeBriefMark);
  const closedAtRest = routerStore.use(routeClosedAtRest);
  const sections = useSections();
  const sidebarShowsTasks =
    getWorkflowSidebarWidth({
      cols: terminalSize.cols,
      sidebarVisible: controls.sidebarVisible,
    }) > 0;
  const pendingTasks = queuedBriefs({
    tasks: runView.briefs,
    phase: runView.phase,
    sidebarShowsTasks,
    closed: closedAtRest,
  });
  const view = conversationViewportWindow({
    height,
    pendingTasks,
    isRunning,
    sections,
    expandedDiffs,
    expandedActivityBatches,
    cols: conversationWidth,
    rawScrollOffset,
    renderableCountAtScroll,
    heightAtScroll,
    streaming,
    tail,
  });

  // The keys and the pointer read the transcript from outside React, so the tail has to reach
  // them, or `home`, `end` and a click stop at the last event the run wrote.
  useEffect(() => {
    publishTranscriptTail(tail ?? []);
    return () => publishTranscriptTail([]);
  }, [tail]);

  useEffect(() => {
    onScrollAbove?.(view.above);
    return () => onScrollAbove?.('');
  }, [view.above, onScrollAbove]);

  useEffect(() => {
    onScrollBelow?.(view.below);
    return () => onScrollBelow?.('');
  }, [view.below, onScrollBelow]);

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
        height={view.transcriptHeight}
        flexDirection="column"
        overflow="hidden"
        flexShrink={0}
      >
        <Box width="100%" flexDirection="column" flexShrink={0}>
          {view.showsEmptyState && (
            <Box marginLeft={rowLeadingCells('message')}>
              <Text color={t.textDim}>no events yet</Text>
            </Box>
          )}
          <ConversationTranscriptRows
            rows={view.rows}
            visibleActiveRowKey={view.visibleActiveRowKey}
            activeTaskHeaderKey={view.activeTaskHeaderKey}
            restMark={restMark}
          />
        </Box>
      </Box>
      {view.queued.rows > 0 && (
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
              {`Pending${INLINE_LABEL_GAP}${pendingTasks.length}${view.queued.rows === 1 && view.queued.hidden > 0 ? `${SOFT_SEP}+${view.queued.hidden} more` : ''}`}
            </Text>
          </Box>
          {view.queued.shown.map((queuedRow) => (
            <Box key={queuedRow.key} height={1} width={conversationWidth} flexShrink={0}>
              <ConversationRowView row={queuedRow} lifecycle="queued" />
            </Box>
          ))}
          {view.queued.hidden > 0 && view.queued.rows > 1 && (
            <Box
              height={1}
              width={conversationWidth}
              overflow="hidden"
              flexShrink={0}
              marginLeft={rowLeadingCells('message')}
            >
              <Text color={t.textDim}>{`+${view.queued.hidden} more`}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
