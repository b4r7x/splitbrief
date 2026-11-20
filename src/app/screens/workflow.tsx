import { plainUserMessage } from '../../core/types/user-input.js';
import { useState } from 'react';
import { Box } from 'ink';
import { readStopMenuRows } from '../../features/workflow/stop/options.js';
import { inlineMenuLayout } from '../../features/workflow/inline-menu/layout.js';
import { resultMenuHeight } from '../../features/workflow/result/options.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { stopStore } from '../../stores/workflow/stop.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { Divider } from '../../components/divider.js';
import { WorkflowBody } from '../../features/workflow/components/body.js';
import { WorkflowFooter, WorkflowHeader } from '../../features/workflow/components/chrome.js';
import { PanelSlot } from '../../features/workflow/components/panel-slot.js';
import { PromptRegion } from '../../features/workflow/components/prompt-region.js';
import {
  useWorkflowScreen,
  type WorkflowScreenDeps,
} from '../../features/workflow/hooks/workflow-screen/use-model.js';
import { useReviewSelection } from '../../features/workflow/hooks/workflow-screen/use-review-selection.js';
import { useQuestionAnswer } from '../../features/workflow/hooks/workflow-screen/use-question-answer.js';
import {
  usePanelKeys,
  usePanels,
} from '../../features/workflow/hooks/workflow-screen/use-panels.js';
import { useAtRestByline } from '../../features/workflow/hooks/workflow-screen/use-at-rest-byline.js';
import { closedBlockKey } from '../../features/workflow/closed/block.js';
import { transcriptTail } from '../../features/workflow/conversation-rows/blocks/tail.js';
import { recordedCrewHeader } from '../../features/workflow/closed/header.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useSessionPreparationTakesPage } from '../session-preparation.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { useStores } from '../../stores/use-many.js';
import { getReviewPanelBudget } from '../../features/workflow/layout/rect.js';
import { selectRailFormAndLine } from '../../features/workflow/layout/chrome-rows.js';
import { workflowScreenLayout } from '../../features/workflow/layout/screen.js';
import { useHeaderSeatLines } from '../../features/workflow/hooks/use-header-seat-lines.js';
import { seatLineText } from '../../core/crew/seat-line/collapse.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { BuildProgressBlock } from '../../features/workflow/components/build-progress.js';
import { useRailCells } from '../../features/workflow/hooks/use-rail-cells.js';
import { getWorkflowPromptRows } from '../../features/workflow/prompt-rows/workflow.js';
import { composerHintFor } from '../../features/workflow/input-hints.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import { haltReadsNoWords } from '../../core/run-view/halt.js';
import { RECOVERY_EMPTY_ENTER_NOTICE } from '../../features/workflow/recovery/actions.js';
import { sessionSelectDeps } from '../prepare-resume.js';
import type { readClipboardImage } from '../../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../../lib/fs/listing.js';
import { draftRefusalStore } from '../../stores/ui/session-drafts.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { getFeedbackRows } from '../../features/workflow/components/feedback-row.js';

interface WorkflowScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string, sentBy?: 'row' | 'answer') => void;
  deps?: WorkflowScreenDeps | undefined;
  readClipboardImage?: typeof readClipboardImage | undefined;
  listProjectFiles?: typeof listProjectFiles | undefined;
}

export function WorkflowScreen({
  commands,
  onRuntimeCommand,
  deps,
  readClipboardImage,
  listProjectFiles,
}: WorkflowScreenProps) {
  const [input, terminal] = useStores(inputHeightStore, terminalSizeStore);
  const { cols, rows } = terminal;
  useStores(stopStore, runViewStore);
  const stopMenuOpen = overlayStore.use((state) => state.active === 'stop-sheet');
  const parked = stopStore.use((state) => state.phase === 'parked');
  const inputRows = input.rows;
  const sidebarVisible = controlsStore.use((s) => s.sidebarVisible);
  const [scrollAboveLabel, setScrollAboveLabel] = useState('');
  const [scrollBelowLabel, setScrollBelowLabel] = useState('');
  const reviewConfirms = reviewStore.use((state) => state.confirms);
  const recoveryIssue = runViewStore.use((view) => view.halt?.issue ?? null);
  const recoveryStepReadsNone = runViewStore.use(haltReadsNoWords);
  const recoveryAsking = recoveryNoticeStore.use((state) => state.asking);
  const feedbackRows = getFeedbackRows(
    feedbackStore.use((state) => state),
    cols,
  );

  const model = useWorkflowScreen({
    onRuntimeCommand,
    // Continuing a run at rest re-prepares its tools through the app's own preparation root,
    // which is where every other seat preparation in the TUI already goes.
    deps: { ...deps, sessionSelect: deps?.sessionSelect ?? sessionSelectDeps },
  });
  const review = useReviewSelection(model);
  const question = useQuestionAnswer(model);
  const plannerQuestions = question.state.questions;

  const questionHint = model.inputMode.mode === 'question' ? model.inputMode.hint : null;
  const recoveryPromptOpen = recoveryIssue !== null && recoveryAsking && questionHint !== null;
  const recoveryFocusKey = recoveryIssue?.id ?? '';
  const ready =
    model.atRestRecord?.status.kind === 'ready-to-apply' ? model.atRestRecord : undefined;
  const gateRequest =
    model.approvalPromptState.status === 'pending' ? model.approvalPromptState.request : undefined;
  const panels = usePanels({
    recovery: { key: recoveryFocusKey, open: recoveryPromptOpen },
    ready,
    stopMenuOpen,
    gate: {
      key: `${gateRequest?.taskId ?? ''}:${gateRequest?.actionDescription ?? ''}`,
      open: model.promptPending,
    },
  });
  const { resultMenuOpen } = panels;
  const reviewBudgetRows = getReviewPanelBudget({ rows, inputRows, feedbackRows });
  const requestedPromptRows = stopMenuOpen
    ? inlineMenuLayout(readStopMenuRows(), cols).height
    : resultMenuOpen
      ? resultMenuHeight(panels.resultMenu, cols)
      : getWorkflowPromptRows({
          approvalState: model.approvalPromptState,
          questionHint,
          review: {
            artifact: review.artifact,
            confirms: reviewConfirms,
            budgetRows: reviewBudgetRows,
          },
          recoveryIssue: recoveryPromptOpen ? recoveryIssue : null,
          questions: plannerQuestions,
          questionIndex: question.state.index,
          questionWriting: question.state.focus === 'answer',
          cols,
        });
  const layout = workflowScreenLayout({
    cols,
    rows,
    inputRows,
    feedbackRows,
    sidebarVisible,
    requestedPromptRows,
    phase: model.phase,
    cancelled: model.cancelled,
    halted: recoveryIssue !== null,
    atRest: model.atRestRecord !== undefined,
    parked,
  });
  // The preparation page covers this screen: a check that stopped, or a gate it opened. The composer
  // under it keeps its draft but takes no keys, so each key on the page means one thing.
  const covered = useSessionPreparationTakesPage();
  const keys = usePanelKeys({
    model,
    panels,
    review,
    question: { structured: question.structured, focus: question.state.focus },
    stopMenuOpen,
    recoveryPromptOpen,
    readyToApply: ready !== undefined,
    covered,
    requestedPromptRows,
    promptBoxRows: layout.promptBoxRows,
  });

  const railWidths = {
    B: useRailCells({
      form: 'B',
      short: false,
      buildBlockShown: layout.progressRows > 0,
      ...(model.railStages !== undefined && { stages: model.railStages }),
    }),
    BShort: useRailCells({
      form: 'B',
      short: true,
      buildBlockShown: layout.progressRows > 0,
      ...(model.railStages !== undefined && { stages: model.railStages }),
    }),
    C: useRailCells({
      form: 'C',
      buildBlockShown: layout.progressRows > 0,
      ...(model.railStages !== undefined && { stages: model.railStages }),
    }),
  };
  const displayedSeatLines = useHeaderSeatLines();
  const railChoice = selectRailFormAndLine({
    cols,
    railWidths,
    modelLineCells: getTerminalCellWidth(seatLineText(displayedSeatLines.model)),
    toolLineCells: getTerminalCellWidth(seatLineText(displayedSeatLines.tool)),
  });
  const railForm = railChoice.form;
  const railCells =
    railForm === 'C' ? railWidths.C : railChoice.short ? railWidths.BShort : railWidths.B;
  const crewChrome =
    model.crewRecord === undefined
      ? null
      : recordedCrewHeader({
          record: model.crewRecord,
          form: railForm,
          short: railChoice.short,
          railCells,
          cols,
        });
  const closedKey =
    model.closed && model.atRestRecord !== undefined
      ? closedBlockKey(model.atRestRecord.ref.sessionId)
      : null;
  const closedExpanded = conversationScrollStore.use(
    (scroll) => closedKey !== null && scroll.expandedActivityBatches.has(closedKey),
  );
  const draftRefusal = draftRefusalStore.use((refusal) => refusal?.message ?? null);
  const viewQuestions = runViewStore.use((view) => view.questions);
  const tail = transcriptTail({
    // The header names the crew that ran the closed run, so the block names it only when the
    // header did not choose the whole model line.
    closedBlock:
      closedKey === null
        ? null
        : {
            key: closedKey,
            view: model.closedView,
            crewNamed: crewChrome?.crewNamed ?? false,
            expanded: closedExpanded,
          },
    closedRun: model.closed,
    plannerAsking: (plannerQuestions?.length ?? 0) > 0,
    atRestRecord: model.atRestRecord,
    viewQuestions,
    draftRefusal,
    width: layout.contentWidth,
    viewportRows: layout.contentHeight,
  });
  const chrome = useAtRestByline({
    model,
    cols,
    closed: closedKey !== null,
    confirming: panels.resultMenu.confirming,
    scrollAboveLabel,
    scrollBelowLabel,
  });

  return (
    <ScreenShell
      header={
        <WorkflowHeader
          scrollAboveLabel={scrollAboveLabel}
          railForm={railForm}
          buildBlockShown={layout.progressRows > 0}
          {...(model.railStages !== undefined && { stages: model.railStages })}
          {...(crewChrome !== null && { seatLine: crewChrome.seatLine })}
        >
          {layout.progressRows > 0 && <BuildProgressBlock cols={cols} />}
        </WorkflowHeader>
      }
      footer={
        <Box flexDirection="column" width="100%" flexShrink={0}>
          <Divider width={cols} tone="textDim" label={chrome.ruleLabel} />
          <WorkflowFooter
            {...keys.footer}
            compactInput={stopMenuOpen || resultMenuOpen}
            beforeComposer={
              stopMenuOpen || resultMenuOpen ? (
                <PanelSlot
                  stopMenuOpen={stopMenuOpen}
                  height={layout.promptBoxRows}
                  ready={ready}
                  panels={panels}
                  keysHeldAbove={keys.keysHeldAbove}
                  onCommand={(raw) => model.handleRuntimeCommand(raw, 'row')}
                />
              ) : undefined
            }
            readClipboardImage={readClipboardImage}
            listProjectFiles={listProjectFiles}
            emptyAnswerNotice={recoveryPromptOpen ? RECOVERY_EMPTY_ENTER_NOTICE : undefined}
            onRuntimeCommand={model.handleRuntimeCommand}
            commands={commands}
            mode={review.waits ? 'normal' : model.inputMode.mode}
            inputHint={composerHintFor({
              stopMenuOpen,
              recovery:
                recoveryPromptOpen && recoveryIssue !== null
                  ? {
                      issue: recoveryIssue,
                      menuFocused: panels.recovery.focused,
                      stepReadsNone: recoveryStepReadsNone,
                    }
                  : null,
              resultMenuFocused: panels.result.focused,
              questionPanelFocused: question.panelFocused,
              structuredQuestion: question.structured,
              plannerAsked: plannerQuestions !== undefined,
              inputModeHint: model.inputMode.hint,
              inputHint: model.inputHint,
            })}
            questionPanelFocused={question.panelFocused}
            onReturnToQuestion={question.structured ? question.returnToQuestion : undefined}
            questionEpoch={model.questionEpoch}
            feedbackHint={chrome.legend}
            commandsOnly={model.commandsOnly}
            waitingForUser={model.inputMode.mode !== 'normal' || model.promptPending}
            buildBlockShown={layout.progressRows > 0}
            keepPlaceholderWhileFocused={
              recoveryPromptOpen || model.atRestRecord !== undefined || model.applying
            }
            onReviewBoundaryNavigate={review.navigateBoundary}
            {...(chrome.byline !== undefined && { byline: chrome.byline })}
            {...(review.artifact !== null
              ? {
                  onEditShortcut: () => {
                    void model.handleInput(plainUserMessage('edit-file'));
                  },
                }
              : {})}
            reviewEpoch={model.inputMode.mode === 'review' ? review.ownerToken : undefined}
          />
        </Box>
      }
    >
      <WorkflowBody
        showSidebar={layout.sidebarWidth > 0}
        sidebarWidth={layout.sidebarWidth}
        inputMode={model.inputMode}
        reviewFilePath={model.reviewFilePath}
        contentHeight={layout.contentHeight}
        contentWidth={layout.contentWidth}
        onScrollAbove={setScrollAboveLabel}
        onScrollBelow={setScrollBelowLabel}
        {...(tail.length > 0 && { transcriptTail: tail })}
        {...(crewChrome !== null && { recordedCrew: crewChrome.seats })}
      />
      <PromptRegion
        boxRows={layout.promptBoxRows}
        cols={cols}
        stopMenuOpen={stopMenuOpen}
        model={model}
        panels={panels}
        review={review}
        confirms={reviewConfirms}
        budgetRows={reviewBudgetRows}
        recoveryKey={recoveryFocusKey}
        recoveryIssue={recoveryPromptOpen ? recoveryIssue : null}
        question={question}
        keysHeldAbove={keys.keysHeldAbove}
      />
    </ScreenShell>
  );
}
