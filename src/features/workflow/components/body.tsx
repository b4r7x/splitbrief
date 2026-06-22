import { Box } from 'ink';
import { dirname } from 'node:path';
import { ConversationFlow } from './conversation-flow/flow.js';
import { ActivitySideRail } from './activity-side-rail.js';
import { Sidebar } from './sidebar.js';
import { BriefReviewView } from './brief-review-view.js';
import { PlanEditorComponent } from './plan-editor/editor.js';
import { PromptBody } from './prompt-body.js';
import { ReviewView } from './review-view.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import { buildTargetedRejectionComment } from '../../../engine/orchestrator/planning/regen-targeted.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import type { Phase } from '../../../core/schemas/enums.js';
import {
  getReviewColumnWidth,
  getWorkflowRuntimeLayout,
  WORKFLOW_CONTENT_PADDING_X,
} from '../layout/rect.js';

export function WorkflowBody({
  showSidebar,
  sidebarWidth,
  inputMode,
  reviewFilePath,
  phase,
  useRichEditor,
  contentHeight,
  contentWidth,
  terminalCols,
}: {
  showSidebar: boolean;
  sidebarWidth: number;
  inputMode: UseInputModeResult;
  reviewFilePath: string | null | undefined;
  phase: Phase;
  useRichEditor: boolean;
  contentHeight: number;
  contentWidth: number;
  terminalCols: number;
}) {
  const isConversationMode = inputMode.mode !== 'review';
  const runtimeLayout = isConversationMode
    ? getWorkflowRuntimeLayout({ contentWidth, terminalCols })
    : { activityRailWidth: 0, conversationWidth: contentWidth, contentWidth };
  const reviewWidth = getReviewColumnWidth(contentWidth);

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
        {inputMode.mode === 'review' &&
        reviewFilePath &&
        phase === 'reviewing-briefs' &&
        useRichEditor ? (
          <PlanEditorComponent
            filePath={reviewFilePath}
            height={contentHeight}
            width={reviewWidth}
            sessionDirPath={dirname(reviewFilePath)}
            onApprove={() => inputMode.resolve({ approved: true })}
            onReject={() => inputMode.resolve({ approved: false })}
            onRegenerateFlagged={async (reason) => {
              const flagged = planEditorStore.getFlaggedTasks();
              if (flagged.length === 0) return;
              const comment = buildTargetedRejectionComment(flagged, reason);
              planEditorStore.clearFlags();
              inputMode.resolve({ approved: false, action: 'revise', comment });
            }}
          />
        ) : inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' ? (
          <BriefReviewView filePath={reviewFilePath} height={contentHeight} width={reviewWidth} />
        ) : inputMode.mode === 'review' && reviewFilePath ? (
          <ReviewView height={contentHeight} width={reviewWidth} />
        ) : inputMode.mode === 'question' ? (
          <PromptBody prompt={inputMode.hint} height={contentHeight} width={contentWidth} />
        ) : (
          <Box flexDirection="row" width={contentWidth} height={contentHeight} overflow="hidden">
            <ConversationFlow height={contentHeight} width={runtimeLayout.conversationWidth} />
            {runtimeLayout.activityRailWidth > 0 && (
              <ActivitySideRail height={contentHeight} width={runtimeLayout.activityRailWidth} />
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
