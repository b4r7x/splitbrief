import { plainUserMessage } from '../../core/types/user-input.js';
import { useLayoutEffect, useRef, useState } from 'react';
import { Box } from 'ink';
import { StopMenu } from '../../features/workflow/stop/menu.js';
import {
  readStopMenuRows,
  STOP_SHEET_COMPOSER_HINT,
  stopMenuLayout,
} from '../../features/workflow/stop/options.js';
import { ResultMenu } from '../../features/workflow/result/menu.js';
import {
  RESULT_MENU_COMPOSER_HINT,
  resultMenuHeight,
} from '../../features/workflow/result/options.js';
import { resultMenuStore } from '../../stores/workflow/result-menu.js';
import { ReviewChecksCard } from '../../features/workflow/review-checks/card.js';
import {
  REVIEW_CHECKS_COMPOSER_HINT,
  reviewChecksCardLayout,
} from '../../features/workflow/review-checks/options.js';
import { reviewChecksPromptStore } from '../../stores/review-checks-prompt/prompt.js';
import { showRunDiff } from '../../features/workflow/result/show-diff.js';
import { changedFileCount } from '../../features/workflow/closed/projections.js';
import { overlayStore } from '../../stores/ui/overlay.js';
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
import { calloutRowsBlock } from '../../features/workflow/conversation-rows/callout-block.js';
import { sectionSpacerBlock } from '../../features/workflow/conversation-rows/build.js';
import { recordedCrewHeader } from '../../features/workflow/closed/header.js';
import {
  applyByline,
  bylineParts,
  legendText,
  openRunBylineParts,
} from '../../features/workflow/closed/byline.js';
import { useSharedClock } from '../../hooks/use-shared-clock.js';
import { departureStore } from '../../stores/workflow/departure.js';
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
import { useRailCells } from '../../features/workflow/hooks/use-rail-cells.js';
import { getWorkflowPromptRows } from '../../features/workflow/prompt-rows/workflow.js';
import {
  reviewArtifactForPhase,
  reviewDocumentOptions,
} from '../../features/workflow/prompt-rows/approval.js';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { questionOptions, questionPromptStore } from '../../stores/question-prompt/prompt.js';
import {
  formatRecoveryPrompt,
  recoveryComposerHint,
} from '../../features/workflow/recovery-prompt.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { navigateIndex } from '../../utils/indexing.js';
import { sessionSelectDeps } from '../prepare-resume.js';
import type { readClipboardImage } from '../../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../../lib/file-listing.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { prepareDraftSubmission, type DraftSubmission } from '../../core/composer/submission.js';
import { plannerSupportsImages } from '../../core/runners/capabilities.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { configStore } from '../../stores/project/config.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { formatSubmissionFailure } from '../../components/composer/home-hint.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { draftRefusalStore } from '../../stores/ui/session-drafts.js';

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
  const parked = stopStore.use((state) => state.phase === 'parked');
  const inputRows = input.rows;
  const sidebarVisible = controlsStore.use((s) => s.sidebarVisible);
  const [scrollAboveLabel, setScrollAboveLabel] = useState('');
  const [scrollBelowLabel, setScrollBelowLabel] = useState('');
  const [reviewSelected, setReviewSelected] = useState(0);
  // Ink delivers every key of one stdin read before React re-renders, so ⏎ right after ↓ runs the
  // composer's handler from the render before ↓. The ref carries the row ↓ moved to across it.
  const reviewSelectedRef = useRef(reviewSelected);
  reviewSelectedRef.current = reviewSelected;
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
    reviewSelectedRef.current = 0;
    setReviewSelected(0);
  }, [reviewArtifact, reviewOwnerToken]);

  const handleReviewBoundaryNavigate = (direction: 'up' | 'down'): boolean => {
    if (reviewArtifact === null) return false;
    const optionCount = reviewDocumentOptions(reviewArtifact).length;
    const next = navigateIndex(direction, reviewSelectedRef.current, optionCount);
    reviewSelectedRef.current = next;
    setReviewSelected(next);
    return true;
  };

  const structuredQuestion =
    model.inputMode.mode === 'question' && (plannerQuestions?.length ?? 0) > 0;

  const answerQuestion = (text: string): void => {
    const state = questionPromptStore.get();
    if (Date.now() - state.openedAt < PROMPT_TYPEAHEAD_GRACE_MS) return;
    if (text.trim() === '') return;
    const { config, projectDir } = configStore.get();
    const submission = prepareDraftSubmission(createDraftDocument(text), {
      projectDir,
      supportsImages: plannerSupportsImages(config, modelCacheStore.getDetection().providers),
    });
    if (!submission.ok && submission.reason === 'command') {
      questionPromptStore.setFocus('answer', '');
      model.handleRuntimeCommand(text.trim());
      return;
    }
    if (!submission.ok) {
      feedbackStore.setError(formatSubmissionFailure(submission));
      return;
    }
    const answered = questionPromptStore.answer(submission.message);
    attachmentsStore.replacePendingImages(
      questionPromptStore.get().answers.flatMap((answer) => answer.images),
    );
    if (answered !== undefined) void model.handleInput(answered.message);
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
  const handleFooterInput = (submission: Extract<DraftSubmission, { ok: true }>): void => {
    const { message } = submission;
    composerLiveStore.setDraft(submission.document);
    if (structuredQuestion) {
      if (message.text.trim() !== '') void model.handleInput(message);
      return;
    }
    if (reviewArtifact !== null && message.displayText.trim() === '') {
      // An open change request takes ⏎ as `send`, and an empty one has nothing to send.
      if (reviewCommenting) return;
      const row = reviewDocumentOptions(reviewArtifact)[reviewSelectedRef.current];
      // The comment row hands the keyboard to the composer the same way a typed `c` does: one
      // empty change request, so there is one way into a review comment and not two.
      if (row === undefined || row.command === 'comment') {
        reviewKeysStore.requestComment();
        return;
      }
      void model.handleInput(plainUserMessage(row.command));
      return;
    }
    void model.handleInput(message);
  };

  // A closed run's account is the block at the end of its transcript: it names the crew that ran
  // and the briefs that landed. The sidebar would answer both again in a column, so the closed
  // presentation takes the whole width instead.
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
  const changedFiles = ready === undefined ? null : changedFileCount(ready.summary);
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
  const railCells = useRailCells({
    form: railForm,
    buildBlockShown: progressRows > 0,
    stages: model.railStages,
  });
  const crewChrome =
    model.crewRecord === undefined
      ? null
      : recordedCrewHeader({ record: model.crewRecord, railCells, cols });
  const closedBlock =
    model.closed && model.atRestRecord !== undefined
      ? closedTranscriptBlock({
          view: model.closedView,
          width: contentWidth,
          theme,
          crewNamed: crewChrome?.crewNamed ?? false,
        })
      : null;
  // A draft that could not be saved is named below the run's own events, so a re-read of the run's
  // history, which replaces those events, never erases the cause and the file.
  const draftRefusal = draftRefusalStore.use((refusal) => refusal?.message ?? null);
  const draftBlock =
    draftRefusal === null
      ? null
      : calloutRowsBlock({
          keyPrefix: 'draft-not-saved',
          label: 'Warning',
          value: draftRefusal,
          width: contentWidth,
          severity: 'warning',
        });
  const transcriptTail = [
    ...(closedBlock === null ? [] : [closedBlock]),
    ...(draftBlock === null ? [] : [sectionSpacerBlock(draftBlock.key), draftBlock]),
  ];

  // The at-rest and Apply bylines carry no pip, so they open on the text column and their budget is
  // what is left of the chrome row past the mark slot.
  const bylineWidth = Math.max(1, getChromeContentWidth(cols) - MARK_SLOT_CELLS);
  // The record carries no Apply start, so the clock counts from when this screen first saw it.
  const [applySince, setApplySince] = useState<number | null>(null);
  useLayoutEffect(() => setApplySince(model.applying ? Date.now() : null), [model.applying]);
  const now = useSharedClock({ active: model.applying });
  const queuedDeparture = departureStore.use((state) => state?.kind ?? null);
  const apply = model.applying
    ? {
        elapsedMs: applySince === null ? 0 : Math.max(0, now - applySince),
        queued: queuedDeparture,
      }
    : undefined;
  const byline =
    model.atRestRecord === undefined
      ? apply === undefined
        ? undefined
        : applyByline(apply, bylineWidth)
      : model.closedView !== null
        ? bylineParts(model.closedView, bylineWidth)
        : openRunBylineParts({
            status: model.atRestRecord.status,
            continuable: model.continuable,
            width: bylineWidth,
            apply,
          });
  // A check running for this run owns Escape and says so on the byline, so the legend above the
  // composer does not offer it for going home at the same time. Neither does a quit queued behind
  // Apply, which Escape no longer changes.
  const checking = preparationStore.use((state) => state.kind === 'checking');
  // A check that stopped covers this screen with the problem panel. The composer under it keeps its
  // draft but takes no keys, so the panel's own retry, back and scroll keys mean one thing each.
  const covered = preparationStore.use(
    (state) => state.kind === 'blocked' || state.kind === 'failed',
  );
  // An overlay, a pending prompt or the problem panel holds the keys. Then neither the composer nor
  // a panel on this screen reads them.
  const keysHeldAbove = model.hasOverlay || model.promptPending || covered;
  const questionPanelFocused = structuredQuestion && questionState.focus !== 'composer';
  // The panel that holds the keys lets go of them for a command requested into the composer, typed
  // as a slash or picked in the palette. The stop sheet covers the panel below it, so closing the
  // sheet releases that panel too and Enter reaches the composer.
  const below = recoveryPromptOpen
    ? {
        focused: recoveryMenuFocused,
        release: () => setRecoveryFocus({ key: recoveryFocusKey, menu: false }),
      }
    : ready !== undefined
      ? {
          focused: resultMenuFocused,
          release: () => setResultFocus({ key: resultFocusKey, menu: false }),
        }
      : checksRequest !== null
        ? {
            focused: checksCardFocused,
            release: () => setChecksFocus({ request: checksRequest, menu: false }),
          }
        : structuredQuestion && questionState.focus === 'menu'
          ? { focused: true, release: () => questionPromptStore.setFocus('composer') }
          : undefined;
  const takeKeys =
    covered || model.promptPending
      ? undefined
      : stopMenuOpen
        ? () => {
            overlayStore.close();
            below?.release();
          }
        : model.hasOverlay || !below?.focused
          ? undefined
          : below.release;
  const commandRequest = composerDraftStore.use((state) =>
    state.request?.kind === 'command' ? state.request.epoch : null,
  );
  useLayoutEffect(() => {
    if (commandRequest !== null) takeKeys?.();
  }, [commandRequest]);
  const legend =
    model.atRestRecord === undefined && !model.applying
      ? model.inputHint
      : legendText({
          overflow: scrollAboveLabel !== '' || scrollBelowLabel !== '',
          width: getChromeContentWidth(cols),
          canGoHome: !checking && queuedDeparture !== 'quit',
        });

  return (
    <ScreenShell
      header={
        <WorkflowHeader
          scrollAboveLabel={scrollAboveLabel}
          railForm={railForm}
          buildBlockShown={progressRows > 0}
          {...(model.railStages !== undefined && { stages: model.railStages })}
          {...(crewChrome !== null && { seatLine: crewChrome.seatLine })}
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
                  focused={resultMenuFocused && !keysHeldAbove}
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
                  focused={checksCardFocused && !keysHeldAbove}
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
              stopMenuOpen
                ? STOP_SHEET_COMPOSER_HINT
                : recoveryPromptOpen && recoveryIssue !== null
                  ? recoveryComposerHint(recoveryIssue, recoveryMenuFocused)
                  : resultMenuFocused
                    ? RESULT_MENU_COMPOSER_HINT
                    : checksCardFocused
                      ? REVIEW_CHECKS_COMPOSER_HINT
                      : questionPanelFocused
                        ? 'Answer the question above…'
                        : structuredQuestion
                          ? 'New instruction — replaces these questions…'
                          : plannerQuestions !== undefined
                            ? model.inputMode.hint
                            : model.inputHint
            }
            questionPanelFocused={questionPanelFocused}
            onReturnToQuestion={structuredQuestion ? returnToQuestion : undefined}
            questionEpoch={model.questionEpoch}
            feedbackHint={legend}
            commandsOnly={model.commandsOnly}
            waitingForUser={
              model.inputMode.mode !== 'normal' || model.promptPending || checksCardOpen
            }
            buildBlockShown={progressRows > 0}
            keepPlaceholderWhileFocused={
              recoveryPromptOpen || model.atRestRecord !== undefined || model.applying
            }
            {...(recoveryPromptOpen
              ? {
                  menuFocused: recoveryMenuFocused,
                  onToggleMenu: () => {
                    setRecoveryFocus({ key: recoveryFocusKey, menu: !recoveryMenuFocused });
                  },
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
            panelHoldsKeys={takeKeys !== undefined}
            onReviewBoundaryNavigate={handleReviewBoundaryNavigate}
            {...(byline !== undefined && { byline })}
            {...(reviewArtifact !== null
              ? {
                  onEditShortcut: () => {
                    void model.handleInput(plainUserMessage('edit-file'));
                  },
                }
              : {})}
            reviewEpoch={model.inputMode.mode === 'review' ? reviewOwnerToken : undefined}
            disabled={keysHeldAbove}
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
        {...(transcriptTail.length > 0 && { transcriptTail })}
        {...(crewChrome !== null && { recordedCrew: crewChrome.seats })}
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
            recoveryMenuFocused={recoveryMenuFocused && !keysHeldAbove}
            onRecoveryFocusChange={(menuFocused) => {
              setRecoveryFocus({ key: recoveryFocusKey, menu: menuFocused });
            }}
            onRecoveryResolve={(answer) => model.inputMode.resolve(plainUserMessage(answer))}
            questions={plannerQuestions}
            planner={
              structuredQuestion
                ? {
                    disabled: keysHeldAbove,
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
