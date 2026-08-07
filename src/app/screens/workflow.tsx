import { useLayoutEffect, useRef, useState } from 'react';
import { Box } from 'ink';
import type {
  RuntimeCommandDef,
  CopyResult,
  CopyTarget,
} from '../../core/runtime/commands/types.js';
import type { Focus } from '../../stores/ui/focus.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { CostApprovalPromptConnected } from '../../features/workflow/components/cost-approval-prompt.js';
import { QuestionPrompt } from '../../features/workflow/components/question-prompt.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { Divider } from '../../features/workflow/components/divider.js';
import { WorkflowBody } from '../../features/workflow/components/body.js';
import { WorkflowFooter, WorkflowHeader } from '../../features/workflow/components/chrome.js';
import {
  DEFAULT_REVIEW_ACTION_ID,
  getReviewActionCommand,
  nextReviewActionId,
  type SelectableReviewActionId,
} from '../../features/workflow/components/brief-review/review-actions.js';
import {
  useWorkflowScreen,
  type WorkflowScreenDeps,
} from '../../features/workflow/hooks/workflow-screen/use-model.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { focusStore } from '../../stores/ui/focus.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { useStores } from '../../stores/use-stores.js';
import {
  clampWorkflowPromptRows,
  getWorkflowContentWidth,
  getWorkflowReviewColumn,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
} from '../../features/workflow/layout/rect.js';
import { selectRailForm } from '../../features/workflow/layout/chrome-rows.js';
import { getWorkflowPromptRows } from '../../features/workflow/prompt-rows/workflow.js';

interface WorkflowScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
  copyTarget?: ((target: CopyTarget) => Promise<CopyResult>) | undefined;
  canCopyFocused?: ((focus: Focus | null) => boolean) | undefined;
  deps?: WorkflowScreenDeps | undefined;
}

export function WorkflowScreen({
  commands,
  onRuntimeCommand,
  copyTarget,
  canCopyFocused,
  deps,
}: WorkflowScreenProps) {
  const [input, terminal] = useStores(inputHeightStore, terminalSizeStore);
  const { cols, rows } = terminal;
  const inputRows = input.rows;
  const sidebarVisible = controlsStore.use((s) => s.sidebarVisible);
  const [scrollAboveLabel, setScrollAboveLabel] = useState('');
  const [scrollBelowLabel, setScrollBelowLabel] = useState('');
  const activeReviewActionIdRef = useRef<SelectableReviewActionId>(DEFAULT_REVIEW_ACTION_ID);
  const reviewActionKeyboardEngagedRef = useRef(false);
  const reviewOwnerToken = reviewStore.use((state) => state.ownerToken);
  const briefFocus = focusStore.use((focus) => focus);

  const model = useWorkflowScreen({ onRuntimeCommand, copyTarget, canCopyFocused, deps });
  const documentReviewActive =
    model.inputMode.mode === 'review' &&
    (model.phase === 'reviewing-plan' || model.phase === 'reviewing-spec');
  const reviewYankActive =
    model.phase === 'reviewing-briefs' && (canCopyFocused?.(briefFocus) ?? false);

  const resetReviewActionSelection = (): void => {
    reviewActionKeyboardEngagedRef.current = false;
    activeReviewActionIdRef.current = DEFAULT_REVIEW_ACTION_ID;
  };

  useLayoutEffect(() => {
    resetReviewActionSelection();
  }, [documentReviewActive, reviewOwnerToken]);

  const handleReviewBoundaryNavigate = (direction: 'up' | 'down'): boolean => {
    if (model.phase === 'reviewing-briefs') {
      return model.navigateBriefReview(direction);
    }
    if (!documentReviewActive || model.hasOverlay || model.promptPending) return false;
    const next = nextReviewActionId(
      activeReviewActionIdRef.current,
      direction === 'down' ? 'next' : 'previous',
    );
    activeReviewActionIdRef.current = next;
    reviewActionKeyboardEngagedRef.current = true;
    return true;
  };

  const handleFooterInput = (text: string): void => {
    if (documentReviewActive && reviewActionKeyboardEngagedRef.current && text.trim() === '') {
      const command = getReviewActionCommand(activeReviewActionIdRef.current);
      resetReviewActionSelection();
      void model.handleInput(command);
      return;
    }
    if (text.length > 0) resetReviewActionSelection();
    void model.handleInput(text);
  };

  const sidebarWidth = getWorkflowSidebarWidth({
    cols,
    sidebarVisible,
  });
  const showSidebar = sidebarWidth > 0;
  const questionHint = model.inputMode.mode === 'question' ? model.inputMode.hint : null;
  const railForm = selectRailForm({ phase: model.phase, cols });
  const promptRows = clampWorkflowPromptRows({
    rows,
    inputRows,
    promptRows: getWorkflowPromptRows({
      approvalState: model.approvalPromptState,
      costApprovalState: model.costApprovalState,
      questionHint,
      cols,
    }),
  });
  const promptBoxRows = model.promptPending ? Math.max(1, promptRows) : promptRows;
  const contentHeight = getWorkflowViewportHeight({
    rows,
    inputRows,
    promptRows: promptBoxRows,
  });
  const contentWidth = getWorkflowContentWidth({
    cols,
    sidebarVisible,
  });
  const reviewColumn =
    model.inputMode.mode === 'review'
      ? getWorkflowReviewColumn({ cols, sidebarVisible })
      : undefined;

  return (
    <ScreenShell
      header={
        <WorkflowHeader
          startedAt={model.startedAt}
          scrollAboveLabel={scrollAboveLabel}
          railForm={railForm}
        />
      }
      footer={
        <>
          <Divider width={cols} tone="textDim" label={scrollBelowLabel} />
          <WorkflowFooter
            handleInput={handleFooterInput}
            onEmptySubmit={model.onEmptySubmit}
            onRuntimeCommand={model.handleRuntimeCommand}
            commands={commands}
            mode={model.inputMode.mode}
            inputHint={model.inputHint}
            questionEpoch={model.questionEpoch}
            feedbackHint={model.feedbackHint}
            boxHintOverride={model.boxHintOverride}
            reviewColumn={reviewColumn}
            waitingForUser={
              model.inputMode.mode !== 'normal' || model.approvalPending || model.costPending
            }
            onReviewBoundaryNavigate={handleReviewBoundaryNavigate}
            {...(documentReviewActive
              ? {
                  onEditShortcut: () => {
                    resetReviewActionSelection();
                    void model.handleInput('edit-file');
                  },
                  onReviewInteraction: resetReviewActionSelection,
                }
              : {})}
            reviewYankActive={reviewYankActive}
            reviewEpoch={model.inputMode.mode === 'review' ? reviewOwnerToken : undefined}
            disabled={
              model.hasOverlay ||
              model.promptPending ||
              (model.isAttachedClient && !model.ipcConnected)
            }
          />
        </>
      }
    >
      <WorkflowBody
        showSidebar={showSidebar}
        sidebarWidth={sidebarWidth}
        inputMode={model.inputMode}
        reviewFilePath={model.reviewFilePath}
        phase={model.phase}
        contentHeight={contentHeight}
        contentWidth={contentWidth}
        onScrollAbove={setScrollAboveLabel}
        onScrollBelow={setScrollBelowLabel}
      />
      <Box height={promptBoxRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        {model.approvalPending && <ApprovalPrompt clampedBoxRows={promptBoxRows} />}
        {model.costPending && <CostApprovalPromptConnected clampedBoxRows={promptBoxRows} />}
        {model.inputMode.mode === 'question' && (
          <QuestionPrompt hint={model.inputMode.hint} width={cols} clampedBoxRows={promptBoxRows} />
        )}
      </Box>
    </ScreenShell>
  );
}
