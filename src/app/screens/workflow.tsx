import { useLayoutEffect, useState } from 'react';
import { Box } from 'ink';
import { StopMenu } from '../../features/workflow/stop/menu.js';
import { readStopMenuRows, stopMenuLayout } from '../../features/workflow/stop/options.js';
import { ResultMenu } from '../../features/workflow/result/menu.js';
import { resultMenuHeight } from '../../features/workflow/result/options.js';
import { resultMenuStore } from '../../stores/workflow/result-menu.js';
import { ReviewChecksCard } from '../../features/workflow/review-checks/card.js';
import { reviewChecksCardLayout } from '../../features/workflow/review-checks/options.js';
import { reviewChecksPromptStore } from '../../stores/review-checks-prompt/prompt.js';
import { showRunDiff } from '../../features/workflow/result/show-diff.js';
import { filesView } from '../../features/workflow/closed/projections.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import { QuestionPrompt } from '../../features/workflow/components/question-prompt.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { Divider } from '../../components/divider.js';
import { MARK_SLOT_CELLS } from '../../components/row-leading.js';
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
import { preparationStore } from '../../stores/navigation/preparation.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { useStores } from '../../stores/use-stores.js';
import {
  clampWorkflowPromptRows,
  getReviewPanelBudget,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
} from '../../features/workflow/layout/rect.js';
import {
  getChromeContentWidth,
  getProgressRows,
  selectRailForm,
  WORKFLOW_GUTTER_X,
} from '../../features/workflow/layout/chrome-rows.js';
import { BuildProgressBlock } from '../../features/workflow/components/build-progress.js';
import { getWorkflowPromptRows } from '../../features/workflow/prompt-rows/workflow.js';
import {
  reviewArtifactForPhase,
  reviewDocumentOptions,
} from '../../features/workflow/prompt-rows/approval.js';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { questionOptions, questionPromptStore } from '../../stores/question-prompt/prompt.js';
import {
  formatRecoveryPrompt,
  recoveryComposerHint,
} from '../../features/workflow/recovery-prompt.js';
import { queuePlaceholder } from '../../features/workflow/input-hints.js';
import { REVIEW_COMMENT_DRAFT } from '../../features/workflow/review-commands.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { navigateIndex } from '../../utils/indexing.js';
import { sessionSelectDeps } from '../prepare-resume.js';
import type { readClipboardImage } from '../../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../../lib/file-listing.js';

interface WorkflowScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
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
  const theme = useTheme();
  const [input, terminal] = useStores(inputHeightStore, terminalSizeStore);
  const { cols, rows } = terminal;
  useStores(stopStore, tasksStore);
  const stopMenuOpen = overlayStore.use((state) => state.active === 'stop-sheet');
  const running = lifecycleStore.use((state) => state.status === 'running');
  const stopping = stopStore.use((state) => state.intent !== 'none');
  const parked = stopStore.use((state) => state.phase === 'parked');
  const inputRows = input.rows;
  const sidebarVisible = controlsStore.use((s) => s.sidebarVisible);
  const [scrollAboveLabel, setScrollAboveLabel] = useState('');
  const [scrollBelowLabel, setScrollBelowLabel] = useState('');
  const [reviewSelected, setReviewSelected] = useState(0);
  const reviewKeysCommenting = reviewKeysStore.use((state) => state.commenting);
  const reviewOwnerToken = reviewStore.use((state) => state.ownerToken);
  const reviewConfirms = reviewStore.use((state) => state.confirms);
  const recoveryIssue = recoveryNoticeStore.use((state) => state.issue);
  const questionState = questionPromptStore.use((state) => state);
  const plannerQuestions = questionState.questions;

  const model = useWorkflowScreen({
    onRuntimeCommand,
    // Continuing a run at rest re-prepares its tools through the app's own preparation root,
    // which is where every other seat preparation in the TUI already goes.
    deps: { ...deps, sessionSelect: deps?.sessionSelect ?? sessionSelectDeps },
  });
  const reviewArtifact =
    model.inputMode.mode === 'review' && !model.promptPending && !model.hasOverlay
      ? reviewArtifactForPhase(model.phase)
      : null;
  // A draft in the composer is what turns the letters back into text, so the flag the composer
  // publishes decides whether the panel advertises them or the two keys a comment answers to.
  const reviewCommenting = reviewArtifact !== null && reviewKeysCommenting;

  useLayoutEffect(() => {
    setReviewSelected(0);
  }, [reviewArtifact, reviewOwnerToken]);

  const handleReviewBoundaryNavigate = (direction: 'up' | 'down'): boolean => {
    if (reviewArtifact === null) return false;
    const optionCount = reviewDocumentOptions(reviewArtifact).length;
    setReviewSelected((index) => navigateIndex(direction, index, optionCount));
    return true;
  };

  const structuredQuestion =
    model.inputMode.mode === 'question' && (plannerQuestions?.length ?? 0) > 0;

  const answerQuestion = (text: string): void => {
    const state = questionPromptStore.get();
    if (Date.now() - state.openedAt < PROMPT_TYPEAHEAD_GRACE_MS) return;
    const answered = questionPromptStore.answer(text);
    if (answered !== undefined) void model.handleInput(answered.text);
  };
  const composeAnswer = (): void => {
    const state = questionPromptStore.get();
    const question = state.questions?.[state.index];
    if (question) questionPromptStore.select(questionOptions(question).length);
    questionPromptStore.setFocus('answer');
  };
  const returnToQuestion = (): void => {
    const state = questionPromptStore.get();
    const question = state.questions?.[state.index];
    const options = question ? questionOptions(question) : [];
    questionPromptStore.setFocus(
      options.length === 0 || state.drafts[state.index]?.selected === options.length
        ? 'answer'
        : 'menu',
    );
  };
  const handleFooterInput = (text: string): void => {
    if (structuredQuestion) {
      if (text.trim() !== '') void model.handleInput(text);
      return;
    }
    if (reviewArtifact !== null && text.trim() === '') {
      const row = reviewDocumentOptions(reviewArtifact)[reviewSelected];
      // The comment row hands the keyboard to the composer the same way a typed `c` does: one
      // prefilled draft, so there is one spelling of a review comment and not two.
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
  const recoveryPromptOpen =
    recoveryIssue !== null &&
    questionHint !== null &&
    questionHint === formatRecoveryPrompt(recoveryIssue);
  const recoveryFocusKey = `${recoveryIssue?.id ?? ''}:${model.inputMode.questionEpoch}`;
  const [recoveryFocus, setRecoveryFocus] = useState<{
    key: string;
    menu: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    setRecoveryFocus((previous) => {
      if (!recoveryPromptOpen) return null;
      return previous?.key === recoveryFocusKey ? previous : { key: recoveryFocusKey, menu: true };
    });
  }, [recoveryFocusKey, recoveryPromptOpen]);
  const recoveryMenuFocused = recoveryPromptOpen
    ? recoveryFocus?.key === recoveryFocusKey
      ? recoveryFocus.menu
      : true
    : false;
  const ready =
    model.atRestRecord?.status.kind === 'ready-to-apply' ? model.atRestRecord : undefined;
  const resultMenuOpen = ready !== undefined && !stopMenuOpen;
  const resultFocusKey = ready?.ref.sessionId ?? '';
  const [confirming, setConfirming] = useState(false);
  const [resultFocus, setResultFocus] = useState<{ key: string; menu: boolean } | null>(null);
  useLayoutEffect(() => {
    setConfirming(false);
    setResultFocus((previous) => {
      if (!resultMenuOpen) return null;
      return previous?.key === resultFocusKey ? previous : { key: resultFocusKey, menu: true };
    });
  }, [resultFocusKey, resultMenuOpen]);
  const resultMenuFocused =
    resultMenuOpen && (resultFocus?.key !== resultFocusKey || resultFocus.menu);
  // One card per review: the reviewer's chosen commands wait here for Run all or Skip all.
  const checksRequest = reviewChecksPromptStore.use((state) =>
    state.status === 'pending' ? state.request : null,
  );
  const checksCardOpen = checksRequest !== null && !stopMenuOpen && !resultMenuOpen;
  const [checksFocus, setChecksFocus] = useState<{
    request: typeof checksRequest;
    menu: boolean;
  } | null>(null);
  const checksCardFocused =
    checksCardOpen && (checksFocus?.request !== checksRequest || checksFocus.menu);
  const override =
    ready !== undefined && ready.status.kind === 'ready-to-apply' ? ready.status.override : false;
  const findings =
    ready !== undefined && ready.hydration.kind === 'loaded'
      ? (ready.hydration.state.acceptedAsIs?.findings ?? [])
      : [];
  const changedFiles =
    ready === undefined || ready.summary === null
      ? null
      : (filesView(ready.summary).changed?.length ?? null);
  const railForm = selectRailForm({ phase: model.phase, cols });
  const reviewBudgetRows = getReviewPanelBudget({ rows, inputRows });
  const requestedPromptRows = stopMenuOpen
    ? stopMenuLayout(readStopMenuRows(), cols).height
    : resultMenuOpen
      ? resultMenuHeight({ override, findings, confirming, files: changedFiles }, cols)
      : checksCardOpen
        ? reviewChecksCardLayout(checksRequest, cols).height
        : getWorkflowPromptRows({
            approvalState: model.approvalPromptState,
            questionHint,
            review: {
              artifact: reviewArtifact,
              confirms: reviewConfirms,
              budgetRows: reviewBudgetRows,
            },
            recoveryIssue: recoveryPromptOpen ? recoveryIssue : null,
            questions: plannerQuestions,
            questionIndex: questionState.index,
            questionWriting: questionState.focus === 'answer',
            cols,
          });
  useLayoutEffect(() => {
    resultMenuStore.setHeight(resultMenuOpen ? requestedPromptRows : null);
    return () => resultMenuStore.reset();
  }, [resultMenuOpen, requestedPromptRows]);
  const progressRows = getProgressRows({
    phase: model.phase,
    cols,
    cancelled: model.cancelled,
    halted: recoveryIssue !== null,
    promptRows: requestedPromptRows,
    atRest: model.atRestRecord !== undefined,
    parked,
  });
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

  // The at-rest byline carries no pip, so it opens on the text column and its budget is what is
  // left of the chrome row past the mark slot.
  const bylineWidth = Math.max(1, getChromeContentWidth(cols) - MARK_SLOT_CELLS);
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
  // A check running for this run owns Escape and says so on the byline, so the legend above the
  // composer does not offer it for going home at the same time.
  const checking = preparationStore.use((state) => state.kind === 'checking');
  // A check that stopped covers this screen with the problem panel. The composer under it keeps its
  // draft but takes no keys, so the panel's own retry, back and scroll keys mean one thing each.
  const covered = preparationStore.use(
    (state) => state.kind === 'blocked' || state.kind === 'failed',
  );
  const legend =
    model.atRestRecord === undefined
      ? model.inputHint
      : legendText({
          overflow: scrollAboveLabel !== '' || scrollBelowLabel !== '',
          width: getChromeContentWidth(cols),
          canGoHome: !checking,
        });

  return (
    <ScreenShell
      header={
        <WorkflowHeader
          startedAt={model.startedAt}
          scrollAboveLabel={scrollAboveLabel}
          railForm={railForm}
          buildBlockShown={progressRows > 0}
          {...(model.railStages !== undefined && { stages: model.railStages })}
          {...(closedChrome !== null && { seatLine: closedChrome.seatLine })}
        >
          {progressRows > 0 && <BuildProgressBlock cols={cols} />}
        </WorkflowHeader>
      }
      footer={
        <Box flexDirection="column" width="100%" flexShrink={0}>
          <Divider width={cols} tone="textDim" label={scrollBelowLabel} />
          <WorkflowFooter
            compactInput={stopMenuOpen || resultMenuOpen || checksCardOpen}
            beforeComposer={
              stopMenuOpen ? (
                <StopMenu height={promptBoxRows} />
              ) : resultMenuOpen ? (
                <ResultMenu
                  height={promptBoxRows}
                  override={override}
                  findings={findings}
                  files={changedFiles}
                  confirming={confirming}
                  onConfirmingChange={setConfirming}
                  focused={
                    resultMenuFocused && !model.hasOverlay && !model.promptPending && !covered
                  }
                  onFocusChange={(menu) => setResultFocus({ key: resultFocusKey, menu })}
                  onCommand={model.handleRuntimeCommand}
                  onShowDiff={() => {
                    if (ready !== undefined) void showRunDiff(ready);
                  }}
                />
              ) : checksCardOpen ? (
                <ReviewChecksCard
                  request={checksRequest}
                  height={promptBoxRows}
                  focused={
                    checksCardFocused && !model.hasOverlay && !model.promptPending && !covered
                  }
                  onFocusChange={(menu) => setChecksFocus({ request: checksRequest, menu })}
                />
              ) : undefined
            }
            handleInput={handleFooterInput}
            readClipboardImage={readClipboardImage}
            listProjectFiles={listProjectFiles}
            onEmptySubmit={
              resultMenuOpen
                ? () => setResultFocus({ key: resultFocusKey, menu: true })
                : checksCardOpen
                  ? () => setChecksFocus({ request: checksRequest, menu: true })
                  : model.onEmptySubmit
            }
            onRuntimeCommand={model.handleRuntimeCommand}
            commands={commands}
            mode={model.inputMode.mode}
            inputHint={
              recoveryPromptOpen && recoveryIssue !== null
                ? recoveryComposerHint(recoveryIssue, recoveryMenuFocused, stopMenuOpen)
                : structuredQuestion
                  ? 'New instruction — replaces these questions…'
                  : plannerQuestions !== undefined
                    ? model.inputMode.hint
                    : model.inputHint
            }
            placeholder={queuePlaceholder({
              phase: model.phase,
              inputMode: model.inputMode.mode,
              running,
              stopping,
            })}
            questionPanelFocused={structuredQuestion && questionState.focus !== 'composer'}
            onReturnToQuestion={structuredQuestion ? returnToQuestion : undefined}
            questionEpoch={model.questionEpoch}
            feedbackHint={legend}
            commandsOnly={model.commandsOnly}
            waitingForUser={
              model.inputMode.mode !== 'normal' || model.promptPending || checksCardOpen
            }
            buildBlockShown={progressRows > 0}
            {...(recoveryPromptOpen
              ? {
                  menuFocused: recoveryMenuFocused,
                  onToggleMenu: () => {
                    setRecoveryFocus({ key: recoveryFocusKey, menu: !recoveryMenuFocused });
                  },
                  keepPlaceholderWhileFocused: true,
                }
              : resultMenuOpen
                ? {
                    menuFocused: resultMenuFocused,
                    onToggleMenu: () => {
                      setResultFocus({ key: resultFocusKey, menu: !resultMenuFocused });
                    },
                  }
                : checksCardOpen
                  ? {
                      menuFocused: checksCardFocused,
                      onToggleMenu: () => {
                        setChecksFocus({ request: checksRequest, menu: !checksCardFocused });
                      },
                    }
                  : {})}
            onReviewBoundaryNavigate={handleReviewBoundaryNavigate}
            {...(byline !== undefined && { byline })}
            {...(reviewArtifact !== null
              ? {
                  onEditShortcut: () => {
                    void model.handleInput('edit-file');
                  },
                }
              : {})}
            reviewEpoch={model.inputMode.mode === 'review' ? reviewOwnerToken : undefined}
            disabled={model.hasOverlay || model.promptPending || covered}
          />
        </Box>
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
      <Box
        height={stopMenuOpen || resultMenuOpen || checksCardOpen ? 0 : promptBoxRows}
        overflow="hidden"
        flexDirection="column"
        flexShrink={0}
        paddingX={WORKFLOW_GUTTER_X}
      >
        {!stopMenuOpen && (model.promptPending || reviewArtifact !== null) && (
          <ApprovalPrompt
            clampedBoxRows={promptBoxRows}
            {...(reviewArtifact === null
              ? {}
              : {
                  review: {
                    artifact: reviewArtifact,
                    confirms: reviewConfirms,
                    budgetRows: reviewBudgetRows,
                    selectedIndex: reviewSelected,
                    commenting: reviewCommenting,
                  },
                })}
          />
        )}
        {!stopMenuOpen && model.inputMode.mode === 'question' && (
          <QuestionPrompt
            key={recoveryFocusKey}
            hint={model.inputMode.hint}
            width={getChromeContentWidth(cols)}
            clampedBoxRows={promptBoxRows}
            recoveryIssue={recoveryPromptOpen ? recoveryIssue : null}
            recoveryMenuFocused={recoveryMenuFocused}
            onRecoveryFocusChange={(menuFocused) => {
              setRecoveryFocus({ key: recoveryFocusKey, menu: menuFocused });
            }}
            onRecoveryResolve={(answer) => model.inputMode.resolve(answer)}
            questions={plannerQuestions}
            planner={
              structuredQuestion
                ? {
                    disabled: model.hasOverlay || model.promptPending || covered,
                    onAnswer: answerQuestion,
                    onCompose: composeAnswer,
                    onPrevious: () => questionPromptStore.previous(),
                  }
                : undefined
            }
          />
        )}
      </Box>
    </ScreenShell>
  );
}
