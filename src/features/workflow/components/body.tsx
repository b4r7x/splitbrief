import { useEffect } from 'react';
import { Box } from 'ink';
import { ConversationFlow } from './conversation-flow/flow.js';
import { Sidebar } from './sidebar.js';
import { BriefReviewView } from './brief-review-view.js';
import { PromptBody } from './prompt-body.js';
import { ReviewView } from './review-view.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import type { Phase } from '../../../core/schemas/enums.js';
import {
  getReviewColumnWidth,
  getWorkflowRuntimeLayout,
  WORKFLOW_CONTENT_PADDING_X,
} from '../layout/rect.js';
import { getWorkflowBodyTopGapRows } from '../layout/chrome-rows.js';

export function WorkflowBody({
  showSidebar,
  sidebarWidth,
  inputMode,
  reviewFilePath,
  phase,
  contentHeight,
  contentWidth,
  onScrollAbove,
}: {
  showSidebar: boolean;
  sidebarWidth: number;
  inputMode: UseInputModeResult;
  reviewFilePath: string | null | undefined;
  phase: Phase;
  contentHeight: number;
  contentWidth: number;
  onScrollAbove?: (label: string) => void;
}) {
  const isConversationMode = inputMode.mode !== 'review';
  const runtimeLayout = isConversationMode
    ? getWorkflowRuntimeLayout({ contentWidth })
    : { conversationWidth: contentWidth, contentWidth };
  const reviewWidth = getReviewColumnWidth(contentWidth);
  const topGapRows = getWorkflowBodyTopGapRows(contentHeight);
  useEffect(() => {
    if (isConversationMode) return;
    onScrollAbove?.('');
  }, [isConversationMode, onScrollAbove]);

  return (
    <Box flexDirection="row" flexGrow={1}>
      {showSidebar && <Sidebar width={sidebarWidth} />}
      <Box
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        overflow="hidden"
        paddingX={WORKFLOW_CONTENT_PADDING_X}
      >
        {topGapRows > 0 && <Box height={topGapRows} flexShrink={0} />}
        {inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' ? (
          <BriefReviewView filePath={reviewFilePath} height={contentHeight} width={reviewWidth} />
        ) : inputMode.mode === 'review' && reviewFilePath ? (
          <ReviewView height={contentHeight} width={reviewWidth} />
        ) : inputMode.mode === 'question' ? (
          <PromptBody prompt={inputMode.hint} height={contentHeight} width={contentWidth} />
        ) : (
          <ConversationFlow
            height={contentHeight}
            conversationWidth={runtimeLayout.conversationWidth}
            contentWidth={contentWidth}
            onScrollAbove={onScrollAbove}
          />
        )}
      </Box>
    </Box>
  );
}
