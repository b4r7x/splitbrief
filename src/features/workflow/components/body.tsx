import { useEffect } from 'react';
import { Box } from 'ink';
import { ConversationFlow } from './conversation-flow/flow.js';
import { Sidebar } from './sidebar.js';
import { BriefReviewView } from './brief-review/view.js';
import { ReviewView } from './review-view.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import type { Phase } from '../../../core/schemas/enums.js';
import {
  getReviewColumnWidth,
  getWorkflowConversationHeight,
  WORKFLOW_CONTENT_PADDING_X,
  WORKFLOW_SIDEBAR_GAP,
} from '../layout/rect.js';

export function WorkflowBody({
  showSidebar,
  sidebarWidth,
  inputMode,
  reviewFilePath,
  phase,
  contentHeight,
  contentWidth,
  onScrollAbove,
  onScrollBelow,
}: {
  showSidebar: boolean;
  sidebarWidth: number;
  inputMode: UseInputModeResult;
  reviewFilePath: string | null | undefined;
  phase: Phase;
  contentHeight: number;
  contentWidth: number;
  onScrollAbove?: (label: string) => void;
  onScrollBelow?: (label: string) => void;
}) {
  const isConversationMode = inputMode.mode !== 'review';
  const reviewWidth = getReviewColumnWidth(contentWidth);
  const bodyPaneHeight = getWorkflowConversationHeight({
    height: contentHeight,
    sidebarWidth: showSidebar ? sidebarWidth : 0,
  });
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
        {inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' ? (
          <BriefReviewView filePath={reviewFilePath} height={bodyPaneHeight} width={reviewWidth} />
        ) : inputMode.mode === 'review' && reviewFilePath ? (
          <ReviewView height={bodyPaneHeight} width={reviewWidth} />
        ) : (
          <ConversationFlow
            height={bodyPaneHeight}
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
