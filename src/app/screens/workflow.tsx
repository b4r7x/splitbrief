import { useLayoutEffect, useState } from 'react';
import { Box } from 'ink';
import type {
  RuntimeCommandDef,
  CopyResult,
  CopyTarget,
} from '../../core/runtime/commands/types.js';
import type { Focus } from '../../stores/ui/focus.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { QuestionPrompt } from '../../features/workflow/components/question-prompt.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { Divider } from '../../components/divider.js';
import { useTheme } from '../../components/theme.js';
import { WorkflowBody } from '../../features/workflow/components/body.js';
import { WorkflowFooter, WorkflowHeader } from '../../features/workflow/components/chrome.js';
import {
  useWorkflowScreen,
  type WorkflowScreenDeps,
} from '../../features/workflow/hooks/workflow-screen/use-model.js';
import { closedTranscriptBlock } from '../../features/workflow/closed/block.js';
import { closedHeader } from '../../features/workflow/closed/header.js';
import { bylineText, legendText, openRunByline } from '../../features/workflow/closed/byline.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { focusStore } from '../../stores/ui/focus.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { useStores } from '../../stores/use-stores.js';
import {
  clampWorkflowPromptRows,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
} from '../../features/workflow/layout/rect.js';
import { getProgressRows, selectRailForm } from '../../features/workflow/layout/chrome-rows.js';
import { BuildProgressBlock } from '../../features/workflow/components/build-progress.js';
import { getWorkflowPromptRows } from '../../features/workflow/prompt-rows/workflow.js';
import {
  reviewArtifactForPhase,
  reviewDocumentOptions,
} from '../../features/workflow/prompt-rows/approval.js';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { REVIEW_COMMENT_DRAFT } from '../../core/keybindings/review.js';
import { clamp } from '../../utils/math.js';
import { sessionSelectDeps } from '../prepare-resume.js';

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
  const theme = useTheme();
  const [input, terminal] = useStores(inputHeightStore, terminalSizeStore);
  const { cols, rows } = terminal;
  const inputRows = input.rows;
  const sidebarVisible = controlsStore.use((s) => s.sidebarVisible);
  const [scrollAboveLabel, setScrollAboveLabel] = useState('');
  const [scrollBelowLabel, setScrollBelowLabel] = useState('');
  const [reviewSelected, setReviewSelected] = useState(0);
  const reviewKeysArmed = reviewKeysStore.use((state) => state.armed);
  const reviewOwnerToken = reviewStore.use((state) => state.ownerToken);
  const briefFocus = focusStore.use((focus) => focus);

  const model = useWorkflowScreen({
    onRuntimeCommand,
    copyTarget,
    canCopyFocused,
    // Continuing a run at rest re-prepares its tools through the app's own preparation root,
    // which is where every other seat preparation in the TUI already goes.
    deps: { ...deps, sessionSelect: deps?.sessionSelect ?? sessionSelectDeps },
  });
  const briefListReview = model.phase === 'reviewing-briefs';
  const reviewArtifact =
    model.inputMode.mode === 'review' && !model.promptPending && !model.hasOverlay
      ? reviewArtifactForPhase(model.phase)
      : null;
  // A draft in the composer is what turns the letters back into text, so the same flag decides
  // whether the panel advertises them or the two keys a comment answers to.
  const reviewCommenting = reviewArtifact !== null && !reviewKeysArmed;
  const reviewYankActive = briefListReview && (canCopyFocused?.(briefFocus) ?? false);

  useLayoutEffect(() => {
    setReviewSelected(0);
  }, [reviewArtifact, reviewOwnerToken]);

  const handleReviewBoundaryNavigate = (direction: 'up' | 'down'): boolean => {
    // A focused brief answers the arrows first; with no list under the gate they move the cursor,
    // which is the only thing every document gate has to move.
    if (briefListReview && model.navigateBriefReview(direction)) return true;
    if (reviewArtifact === null) return false;
    const lastRow = reviewDocumentOptions(reviewArtifact).length - 1;
    setReviewSelected((index) => clamp(index + (direction === 'down' ? 1 : -1), 0, lastRow));
    return true;
  };

  const handleFooterInput = (text: string): void => {
    if (reviewArtifact !== null && text.trim() === '') {
      const row = reviewDocumentOptions(reviewArtifact)[reviewSelected];
      // The comment row hands the keyboard to the composer the same way the `c` accelerator does:
      // one prefilled draft, so there is one spelling of a review comment and not two.
      if (row === undefined || row.command === 'comment') {
        composerDraftStore.request(REVIEW_COMMENT_DRAFT);
        return;
      }
      void model.handleInput(row.command);
      return;
    }
    void model.handleInput(text);
  };

  // A closed run's account is the block at the end of its transcript: it names the crew that ran
  // and the briefs that landed. The sidebar would answer both again from today's config, so the
  // closed presentation takes the whole width instead of contradicting itself in a column.
  const sidebarWanted = sidebarVisible && !model.closed;
  const sidebarWidth = getWorkflowSidebarWidth({
    cols,
    sidebarVisible: sidebarWanted,
  });
  const showSidebar = sidebarWidth > 0;
  const questionHint = model.inputMode.mode === 'question' ? model.inputMode.hint : null;
  const railForm = selectRailForm({ phase: model.phase, cols });
  const requestedPromptRows = getWorkflowPromptRows({
    approvalState: model.approvalPromptState,
    questionHint,
    reviewArtifact,
    cols,
  });
  // A gate on screen is the only thing to act on, and it needs every row it can get. The build
  // block stands down while one is open rather than clipping the panel that is waiting on an answer.
  const progressRows =
    requestedPromptRows > 0 || model.atRestRecord !== undefined
      ? 0
      : getProgressRows({ phase: model.phase, cols, cancelled: model.cancelled });
  const promptRows = clampWorkflowPromptRows({
    rows,
    inputRows,
    progressRows,
    promptRows: requestedPromptRows,
  });
  const promptBoxRows = model.promptPending ? Math.max(1, promptRows) : promptRows;
  const contentHeight = getWorkflowViewportHeight({
    rows,
    inputRows,
    progressRows,
    promptRows: promptBoxRows,
  });
  const contentWidth = getWorkflowContentWidth({
    cols,
    sidebarVisible: sidebarWanted,
  });

  // The closed run's ledger is the tail of its own transcript: one scroller, the verdict below the
  // last event the run wrote. The header names the crew that ran it, so the block names it only
  // when the line could not afford all three seats.
  const closedChrome =
    model.closedView === null ? null : closedHeader({ view: model.closedView, cols });
  const transcriptTail =
    model.closed && model.atRestRecord !== undefined
      ? [
          closedTranscriptBlock({
            view: model.closedView,
            width: contentWidth,
            theme,
            crewNamed: closedChrome?.crewNamed ?? false,
          }),
        ]
      : undefined;

  const bylineWidth = cols;
  const byline =
    model.atRestRecord === undefined
      ? undefined
      : model.closedView !== null
        ? bylineText(model.closedView, bylineWidth)
        : openRunByline({
            status: model.atRestRecord.status,
            continuable: model.continuable,
            width: bylineWidth,
          });
  const legend =
    model.atRestRecord === undefined
      ? model.inputHint
      : legendText({
          overflow: scrollAboveLabel !== '' || scrollBelowLabel !== '',
          width: contentWidth,
        });

  return (
    <ScreenShell
      header={
        <WorkflowHeader
          startedAt={model.startedAt}
          scrollAboveLabel={scrollAboveLabel}
          railForm={railForm}
          {...(model.railStages !== undefined && { stages: model.railStages })}
          {...(closedChrome !== null && { seatLine: closedChrome.seatLine })}
        >
          {progressRows > 0 && <BuildProgressBlock cols={cols} />}
        </WorkflowHeader>
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
            feedbackHint={legend}
            commandsOnly={model.commandsOnly}
            waitingForUser={model.inputMode.mode !== 'normal' || model.promptPending}
            onReviewBoundaryNavigate={handleReviewBoundaryNavigate}
            {...(byline !== undefined && { byline })}
            {...(reviewArtifact !== null
              ? {
                  onEditShortcut: () => {
                    void model.handleInput('edit-file');
                  },
                }
              : {})}
            reviewYankActive={reviewYankActive}
            reviewEpoch={model.inputMode.mode === 'review' ? reviewOwnerToken : undefined}
            disabled={model.hasOverlay || model.promptPending}
          />
        </>
      }
    >
      <WorkflowBody
        showSidebar={showSidebar}
        sidebarWidth={sidebarWidth}
        inputMode={model.inputMode}
        reviewFilePath={model.reviewFilePath}
        contentHeight={contentHeight}
        contentWidth={contentWidth}
        onScrollAbove={setScrollAboveLabel}
        onScrollBelow={setScrollBelowLabel}
        {...(transcriptTail !== undefined && { transcriptTail })}
      />
      <Box height={promptBoxRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        {(model.promptPending || reviewArtifact !== null) && (
          <ApprovalPrompt
            clampedBoxRows={promptBoxRows}
            {...(reviewArtifact === null
              ? {}
              : {
                  review: {
                    artifact: reviewArtifact,
                    selectedIndex: reviewSelected,
                    commenting: reviewCommenting,
                  },
                })}
          />
        )}
        {model.inputMode.mode === 'question' && (
          <QuestionPrompt hint={model.inputMode.hint} width={cols} clampedBoxRows={promptBoxRows} />
        )}
      </Box>
    </ScreenShell>
  );
}
