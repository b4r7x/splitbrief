import { useEffect } from 'react';
import { Box } from 'ink';
import type { ConversationRowBlock } from '../conversation-rows/types.js';
import { ConversationFlow } from './conversation-flow/flow.js';
import { Sidebar } from './sidebar.js';
import type { RecordedCrew } from '../closed/view-model.js';
import { ReviewView } from './review-view.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import { REVIEW_MIN_ROWS, WORKFLOW_SIDEBAR_GAP } from '../layout/rect.js';
import { WORKFLOW_GUTTER_X } from '../layout/chrome-rows.js';

export function WorkflowBody({
  showSidebar,
  sidebarWidth,
  inputMode,
  reviewFilePath,
  contentHeight,
  contentWidth,
  onScrollAbove,
  onScrollBelow,
  transcriptTail,
  recordedCrew,
}: {
  showSidebar: boolean;
  sidebarWidth: number;
  inputMode: UseInputModeResult;
  reviewFilePath: string | null | undefined;
  contentHeight: number;
  contentWidth: number;
  onScrollAbove?: (label: string) => void;
  onScrollBelow?: (label: string) => void;
  /** Blocks that follow the last event the run wrote; a closed run's ledger is the only one. */
  transcriptTail?: readonly ConversationRowBlock[] | undefined;
  /** The crew the run's record names; the sidebar names it instead of today's crew. */
  recordedCrew?: RecordedCrew | undefined;
}) {
  // A region too short to seat a document row gets the conversation instead: the frame would paint
  // an empty box over the approval panel it is meant to explain.
  const showReview =
    inputMode.mode === 'review' &&
    (reviewFilePath ?? '') !== '' &&
    contentHeight >= REVIEW_MIN_ROWS;
  const isConversationMode = !showReview;
  useEffect(() => {
    if (isConversationMode) return;
    onScrollAbove?.('');
    onScrollBelow?.('');
  }, [isConversationMode, onScrollAbove, onScrollBelow]);

  // The transcript spends the gutter as its own lead, so the pane starts at column 0; the sidebar is
  // a box, and it stands on the gutter line the transcript's marks do.
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      paddingLeft={showSidebar ? WORKFLOW_GUTTER_X : 0}
      paddingRight={WORKFLOW_GUTTER_X}
    >
      {showSidebar && (
        <Sidebar
          width={sidebarWidth}
          height={contentHeight}
          {...(recordedCrew !== undefined && { recordedCrew })}
        />
      )}
      {showSidebar && <Box width={WORKFLOW_SIDEBAR_GAP} flexShrink={0} />}
      <Box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden">
        {showReview ? (
          <ReviewView height={contentHeight} width={contentWidth} />
        ) : (
          <ConversationFlow
            height={contentHeight}
            conversationWidth={contentWidth}
            contentWidth={contentWidth}
            onScrollAbove={onScrollAbove}
            onScrollBelow={onScrollBelow}
            {...(transcriptTail !== undefined && { tail: transcriptTail })}
          />
        )}
      </Box>
    </Box>
  );
}
