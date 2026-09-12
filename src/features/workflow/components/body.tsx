import { useEffect } from 'react';
import { Box } from 'ink';
import { ConversationFlow } from './conversation-flow/flow.js';
import { Sidebar } from './sidebar.js';
import { ReviewView } from './review-view.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import {
  getReviewColumnWidth,
  REVIEW_MIN_ROWS,
  WORKFLOW_CONTENT_PADDING_X,
  WORKFLOW_SIDEBAR_GAP,
} from '../layout/rect.js';

export function WorkflowBody({
  showSidebar,
  sidebarWidth,
  inputMode,
  reviewFilePath,
  contentHeight,
  contentWidth,
  onScrollAbove,
  onScrollBelow,
}: {
  showSidebar: boolean;
  sidebarWidth: number;
  inputMode: UseInputModeResult;
  reviewFilePath: string | null | undefined;
  contentHeight: number;
  contentWidth: number;
  onScrollAbove?: (label: string) => void;
  onScrollBelow?: (label: string) => void;
}) {
  // A region too short to seat a document row gets the conversation instead: the frame would paint
  // an empty box over the approval panel it is meant to explain.
  const showReview =
    inputMode.mode === 'review' &&
    (reviewFilePath ?? '') !== '' &&
    contentHeight >= REVIEW_MIN_ROWS;
  const isConversationMode = !showReview;
  const reviewWidth = getReviewColumnWidth(contentWidth);
  useEffect(() => {
    if (isConversationMode) return;
    onScrollAbove?.('');
    onScrollBelow?.('');
  }, [isConversationMode, onScrollAbove, onScrollBelow]);

  return (
    <Box flexDirection="row" flexGrow={1}>
      {showSidebar && <Sidebar width={sidebarWidth} height={contentHeight} />}
      {showSidebar && <Box width={WORKFLOW_SIDEBAR_GAP} flexShrink={0} />}
      <Box
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        overflow="hidden"
        paddingX={WORKFLOW_CONTENT_PADDING_X}
      >
        {showReview ? (
          <ReviewView height={contentHeight} width={reviewWidth} />
        ) : (
          <ConversationFlow
            height={contentHeight}
            conversationWidth={contentWidth}
            contentWidth={contentWidth}
            onScrollAbove={onScrollAbove}
            onScrollBelow={onScrollBelow}
          />
        )}
      </Box>
    </Box>
  );
}
