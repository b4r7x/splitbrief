import { plainUserMessage } from '../../core/types/user-input.js';
import { useLayoutEffect, useState } from 'react';
import { Box } from 'ink';
import { StopMenu } from '../../features/workflow/stop/menu.js';
import {
  readStopMenuRows,
  STOP_SHEET_COMPOSER_HINT,
} from '../../features/workflow/stop/options.js';
import { inlineMenuLayout } from '../../features/workflow/inline-menu/layout.js';
import { ResultMenu } from '../../features/workflow/result/menu.js';
import { acceptedNote } from '../../core/review/accepted.js';
import {
  RESULT_MENU_COMPOSER_HINT,
  resultMenuHeight,
} from '../../features/workflow/result/options.js';
import { resultMenuStore } from '../../stores/workflow/result-menu.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { showRunDiff } from '../../features/workflow/result/show-diff.js';
import { changedFileCount } from '../../features/workflow/closed/projections.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { stopStore } from '../../stores/workflow/stop.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt/prompt.js';
import { QuestionPrompt } from '../../features/workflow/components/question-prompt.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { Divider } from '../../components/divider.js';
import { MARK_SLOT_CELLS } from '../../components/row-leading.js';
import { WorkflowBody } from '../../features/workflow/components/body.js';
import { WorkflowFooter, WorkflowHeader } from '../../features/workflow/components/chrome.js';
import {
  useWorkflowScreen,
  type WorkflowScreenDeps,
} from '../../features/workflow/hooks/workflow-screen/use-model.js';
import { closedBlockKey, closedTranscriptBlock } from '../../features/workflow/closed/block.js';
import { calloutRowsBlock } from '../../features/workflow/conversation-rows/blocks/callout.js';
import { sectionSpacerBlock } from '../../features/workflow/conversation-rows/blocks/compose.js';
import { applyRunning, openRoundQuestions } from '../../features/workflow/at-rest.js';
import { unansweredQuestionsRowBlock } from '../../features/workflow/conversation-rows/event-rows/answered-questions.js';
import { recordedCrewHeader } from '../../features/workflow/closed/header.js';
import { bylineParts, legendText, runClosedLabel } from '../../features/workflow/closed/byline.js';
import { applyByline, openRunBylineParts } from '../../features/workflow/closed/open-byline.js';
import { useSharedClock } from '../../hooks/use-shared-clock.js';
import { useKeyState } from '../../hooks/use-key-state.js';
import { seatWaitParts } from '../../core/sessions/seat-wait-line.js';
import { SOFT_SEP } from '../../core/separators.js';
import { departureStore } from '../../stores/workflow/departure.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { preparationStore } from '../../stores/navigation/preparation.js';
import { useSessionPreparationTakesPage } from '../session-preparation.js';
import { isQueuePhase } from '../../core/phases/roles.js';
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
import { getChromeHeight } from '../../features/workflow/layout/chrome-rows.js';
import {
  getChromeContentWidth,
  getProgressRows,
  selectRailFormAndLine,
  WORKFLOW_GUTTER_X,
} from '../../features/workflow/layout/chrome-rows.js';
import { useHeaderSeatLines } from '../../features/workflow/hooks/use-header-seat-lines.js';
import { seatLineText } from '../../core/crew/seat-line/collapse.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { BuildProgressBlock } from '../../features/workflow/components/build-progress.js';
import { useRailCells } from '../../features/workflow/hooks/use-rail-cells.js';
import { usePanelFocus } from '../../features/workflow/hooks/use-panel-focus.js';
import { plainAnswer } from '../../features/workflow/hooks/use-input-mode.js';
import { getWorkflowPromptRows } from '../../features/workflow/prompt-rows/workflow.js';
import {
  reviewArtifactForPhase,
  reviewDocumentOptions,
} from '../../features/workflow/prompt-rows/review-document.js';
import {
  draftApprovesPlan,
  reviewDraftTarget,
} from '../../features/workflow/review-gate/commands.js';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import { haltReadsNoWords } from '../../core/run-view/halt.js';
import { questionOptions, questionPromptStore } from '../../stores/prompts/question.js';
import {
  recoveryComposerHint,
  RECOVERY_EMPTY_ENTER_NOTICE,
} from '../../features/workflow/recovery/actions.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { navigateIndex } from '../../utils/indexing.js';
import { sessionSelectDeps } from '../prepare-resume.js';
import type { readClipboardImage } from '../../core/attachments/clipboard-image.js';
import type { listProjectFiles } from '../../lib/fs/listing.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { prepareDraftSubmission, type DraftSubmission } from '../../core/composer/submission.js';
import { plannerSupportsImages } from '../../engine/providers/capabilities.js';
import { seatWaitMoved } from '../../core/sessions/held-seat.js';
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
  const [reviewSelected, setReviewSelected, latestReviewSelected] = useKeyState(0);
  const reviewKeysCommenting = reviewKeysStore.use((state) => state.commenting);
  const reviewKeysRequested = reviewKeysStore.use((state) => state.requested);
  const composerDraftText = composerLiveStore.use((state) => state.text);
  const composerApproves = composerLiveStore.use((state) => draftApprovesPlan(state.document));
  const reviewOwnerToken = reviewStore.use((state) => state.ownerToken);
  const reviewConfirms = reviewStore.use((state) => state.confirms);
  const recoveryIssue = runViewStore.use((view) => view.halt?.issue ?? null);
  const recoveryStepReadsNone = runViewStore.use(haltReadsNoWords);
  const recoveryAsking = recoveryNoticeStore.use((state) => state.asking);
  const questionState = questionPromptStore.use((state) => state);
  const plannerQuestions = questionState.questions;

  const model = useWorkflowScreen({
    onRuntimeCommand,
    // Continuing a run at rest re-prepares its tools through the app's own preparation root,
    // which is where every other seat preparation in the TUI already goes.
    deps: { ...deps, sessionSelect: deps?.sessionSelect ?? sessionSelectDeps },
  });
  const planCardArtifact =
    model.inputMode.mode === 'review' && !model.promptPending
      ? reviewArtifactForPhase(model.phase)
      : null;
  // An overlay takes the paint of the plan card. The card stays open below it, with its focus.
  const planCardOpen = planCardArtifact !== null;
  const reviewArtifact = model.hasOverlay ? null : planCardArtifact;
  useLayoutEffect(() => {
    setReviewSelected(0);
  }, [planCardArtifact, reviewOwnerToken]);
  const { focused: planCardFocused, setMenu: setPlanCardFocused } = usePanelFocus(
    String(reviewOwnerToken),
    planCardOpen,
  );
  const planCardWaits = planCardOpen && !planCardFocused;
  // A draft in the composer is what turns the letters back into text, so the flag the composer
  // publishes decides whether the panel follows the draft or the row ↓ moved to. Over a waiting
  // card the draft takes a row only when it is the word approve.
  const reviewDraft =
    reviewArtifact === null
      ? null
      : planCardWaits
        ? composerApproves
          ? 'approve'
          : null
        : reviewKeysCommenting
          ? reviewDraftTarget(composerDraftText, reviewKeysRequested)
          : null;

  const handleReviewBoundaryNavigate = (direction: 'up' | 'down'): boolean => {
    if (reviewArtifact === null) return false;
    const optionCount = reviewDocumentOptions(reviewArtifact).length;
    setReviewSelected(navigateIndex(direction, latestReviewSelected(), optionCount));
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
      supportsImages: plannerSupportsImages(config, modelCacheStore),
    });
    if (!submission.ok && submission.reason === 'command') {
      questionPromptStore.setFocus('answer', '');
      model.handleRuntimeCommand(text.trim(), 'answer');
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
  const decideQuestions = (): void => {
    const decided = questionPromptStore.decideForMe();
    if (decided !== undefined) void model.handleInput(decided.message);
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
    // The card opened over the draft, so the whole draft is the change request, whatever word it
    // opens with. A draft of only approve takes the Approve row.
    if (planCardWaits) {
      if (draftApprovesPlan(submission.document)) {
        void model.handleInput(plainUserMessage('approve'));
        return;
      }
      model.inputMode.resolve({ approved: false, action: 'revise', message });
      return;
    }
    if (reviewArtifact !== null && message.displayText.trim() === '') {
      // An open change request takes ⏎ as `send`, and an empty one has nothing to send.
      // With no row in view there is no row for ⏎ to take.
      if (reviewDraft !== null || promptBoxRows === 0) return;
      const row = reviewDocumentOptions(reviewArtifact)[latestReviewSelected()];
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

  const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible });
  const showSidebar = sidebarWidth > 0;
  const questionHint = model.inputMode.mode === 'question' ? model.inputMode.hint : null;
  const recoveryPromptOpen = recoveryIssue !== null && recoveryAsking && questionHint !== null;
  const recoveryFocusKey = recoveryIssue?.id ?? '';
  const { focused: recoveryMenuFocused, setMenu: setRecoveryMenu } = usePanelFocus(
    recoveryFocusKey,
    recoveryPromptOpen,
  );
  const ready =
    model.atRestRecord?.status.kind === 'ready-to-apply' ? model.atRestRecord : undefined;
  const resultMenuOpen = ready !== undefined && !stopMenuOpen;
  const resultFocusKey = ready?.ref.sessionId ?? '';
  const [confirming, setConfirming] = useState(false);
  useLayoutEffect(() => {
    setConfirming(false);
  }, [resultFocusKey, resultMenuOpen]);
  const { focused: resultMenuFocused, setMenu: setResultMenu } = usePanelFocus(
    resultFocusKey,
    resultMenuOpen,
  );
  const gateRequest =
    model.approvalPromptState.status === 'pending' ? model.approvalPromptState.request : undefined;
  const { focused: gateFocused, setMenu: setGateMenu } = usePanelFocus(
    `${gateRequest?.taskId ?? ''}:${gateRequest?.actionDescription ?? ''}`,
    model.promptPending,
  );
  const override =
    ready !== undefined && ready.status.kind === 'ready-to-apply' ? ready.status.override : false;
  const accepted =
    ready !== undefined && ready.hydration.kind === 'loaded'
      ? ready.hydration.state.acceptedAsIs
      : undefined;
  const findings = accepted?.findings ?? [];
  const redChecks = accepted?.redChecks;
  const acceptNote = accepted === undefined ? undefined : acceptedNote(accepted);
  const changedFiles = ready === undefined ? null : changedFileCount(ready.summary);
  const reviewBudgetRows = getReviewPanelBudget({ rows, inputRows });
  const requestedPromptRows = stopMenuOpen
    ? inlineMenuLayout(readStopMenuRows(), cols).height
    : resultMenuOpen
      ? resultMenuHeight(
          { override, findings, redChecks, note: acceptNote, confirming, files: changedFiles },
          cols,
        )
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
  // An open panel keeps a row while the chrome fits; the header gives its row up first.
  const promptBoxRows =
    rows < getChromeHeight(inputRows, progressRows)
      ? 0
      : Math.max(Math.min(1, requestedPromptRows), promptRows);
  const contentHeight = getWorkflowViewportHeight({
    rows,
    inputRows,
    progressRows,
    promptRows: promptBoxRows,
  });
  const contentWidth = getWorkflowContentWidth({ cols, sidebarVisible });

  // The closed run's ledger is the tail of its own transcript: one scroller, the verdict below the
  // last event the run wrote. The header names the crew that ran it, so the block names it only
  // when the header did not choose the whole model line.
  const railWidths = {
    B: useRailCells({
      form: 'B',
      short: false,
      buildBlockShown: progressRows > 0,
      ...(model.railStages !== undefined && { stages: model.railStages }),
    }),
    BShort: useRailCells({
      form: 'B',
      short: true,
      buildBlockShown: progressRows > 0,
      ...(model.railStages !== undefined && { stages: model.railStages }),
    }),
    C: useRailCells({
      form: 'C',
      buildBlockShown: progressRows > 0,
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
  const closedBlock =
    closedKey === null
      ? null
      : closedTranscriptBlock({
          key: closedKey,
          view: model.closedView,
          width: contentWidth,
          viewportRows: contentHeight,
          crewNamed: crewChrome?.crewNamed ?? false,
          expanded: closedExpanded,
        });
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
  // A round Esc closed stays on screen until the reply answers it; an open run at rest shows the
  // round it waits at. Neither repeats a question the panel is showing.
  const viewQuestions = runViewStore.use((view) => view.questions);
  const roundBlock = unansweredQuestionsRowBlock({
    keyPrefix: 'open-round',
    questions:
      model.closed || (plannerQuestions?.length ?? 0) > 0
        ? []
        : model.atRestRecord === undefined
          ? (viewQuestions ?? [])
          : openRoundQuestions(model.atRestRecord, viewQuestions),
    width: contentWidth,
  });
  const transcriptTail = [
    ...(closedBlock === null ? [] : [sectionSpacerBlock(closedBlock.key), closedBlock]),
    ...(roundBlock === null ? [] : [sectionSpacerBlock(roundBlock.key), roundBlock]),
    ...(draftBlock === null ? [] : [sectionSpacerBlock(draftBlock.key), draftBlock]),
  ];

  // The at-rest and Apply bylines carry no pip, so they open on the text column and their budget is
  // what is left of the chrome row past the mark slot.
  const bylineWidth = Math.max(1, getChromeContentWidth(cols) - MARK_SLOT_CELLS);
  const config = configStore.useConfig();
  const atRestStatus = model.atRestRecord?.status;
  const viewWait = runViewStore.use((view) => view.seatWait);
  // An open run continues with this window's crew, so its saved wait on a tool the seat no longer
  // runs waits no more. A run another process drives waits on the crew that process loaded.
  const wait =
    viewWait === null || (atRestStatus?.kind === 'open' && seatWaitMoved(viewWait.wait, config))
      ? null
      : viewWait;
  // The run's log names when an Apply started, here or in another process. A log written before it
  // did leaves another process's Apply to the running line, which has no clock to get wrong.
  const applyClock = runViewStore.use((view) => view.apply);
  const planCard = runViewStore.use((view) => view.planCard);
  const failure = runViewStore.use((view) => view.failure);
  const applying =
    model.applying ||
    (model.atRestRecord !== undefined &&
      applyRunning(model.atRestRecord) &&
      applyClock?.until === null);
  // A wait's text goes when its reset passes, so the byline needs the clock while one shows at the
  // clock's own sample: the tick that passes the reset is the frame that drops the wait.
  const now = useSharedClock({
    active: (sample) =>
      applying || (wait !== null && seatWaitParts(wait.tool, wait.wait.resetAt, sample) !== null),
  });
  // The rule above the composer ends a closed run: it says so, before what still waits below.
  const ruleLabel =
    closedKey === null
      ? scrollBelowLabel
      : [runClosedLabel(model.closedView?.closedAt ?? null), scrollBelowLabel]
          .filter((part) => part !== '')
          .join(SOFT_SEP);
  const queuedDeparture = departureStore.use((state) => state?.kind ?? null);
  // This process's Apply reads 0:00 until the bus delivers its start.
  const apply = applying
    ? {
        elapsedMs:
          applyClock === null ? 0 : Math.max(0, (applyClock.until ?? now) - applyClock.since),
        queued: queuedDeparture,
      }
    : undefined;
  const byline =
    atRestStatus === undefined
      ? apply === undefined
        ? undefined
        : applyByline(apply, bylineWidth)
      : model.closedView !== null
        ? apply !== undefined && apply.queued !== null
          ? applyByline(apply, bylineWidth)
          : bylineParts(model.closedView, bylineWidth)
        : openRunBylineParts({
            status: atRestStatus,
            wait,
            planCard,
            failure,
            continuable: model.continuable,
            width: bylineWidth,
            now,
            apply,
            confirming,
          });
  // A check running for this run owns Escape and says so on the byline, so the legend above the
  // composer does not offer it for going home at the same time. Neither does a quit queued behind
  // Apply, which Escape no longer changes.
  const checking = preparationStore.use((state) => state.kind === 'checking');
  // The preparation page covers this screen: a check that stopped, or a gate it opened. The composer
  // under it keeps its draft but takes no keys, so each key on the page means one thing.
  const covered = useSessionPreparationTakesPage();
  // An overlay, a focused gate or the preparation page holds the keys. Then neither the composer
  // nor a panel on this screen reads them.
  const keysHeldAbove = model.hasOverlay || (model.promptPending && gateFocused) || covered;
  const questionPanelFocused = structuredQuestion && questionState.focus !== 'composer';
  // The panel that holds the keys lets go of them for a command requested into the composer, typed
  // as a slash or picked in the palette. The stop sheet covers the panel below it, so closing the
  // sheet releases that panel too and Enter reaches the composer.
  const below = recoveryPromptOpen
    ? {
        focused: recoveryMenuFocused,
        release: () => setRecoveryMenu(false),
      }
    : ready !== undefined
      ? {
          focused: resultMenuFocused,
          release: () => setResultMenu(false),
        }
      : structuredQuestion && questionState.focus === 'menu'
        ? { focused: true, release: () => questionPromptStore.setFocus('composer') }
        : undefined;
  const takeKeys =
    covered || (model.promptPending && gateFocused)
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
          canOpenCommands: !checking,
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
          <Divider width={cols} tone="textDim" label={ruleLabel} />
          <WorkflowFooter
            compactInput={stopMenuOpen || resultMenuOpen}
            beforeComposer={
              stopMenuOpen ? (
                <StopMenu height={promptBoxRows} />
              ) : resultMenuOpen ? (
                <ResultMenu
                  height={promptBoxRows}
                  override={override}
                  findings={findings}
                  redChecks={redChecks}
                  note={acceptNote}
                  files={changedFiles}
                  confirming={confirming}
                  onConfirmingChange={setConfirming}
                  focused={resultMenuFocused && !keysHeldAbove}
                  onFocusChange={setResultMenu}
                  onCommand={(raw) => model.handleRuntimeCommand(raw, 'row')}
                  onShowDiff={() => {
                    if (ready !== undefined) void showRunDiff(ready);
                  }}
                />
              ) : undefined
            }
            handleInput={handleFooterInput}
            readClipboardImage={readClipboardImage}
            listProjectFiles={listProjectFiles}
            onEmptySubmit={
              model.promptPending
                ? () => setGateMenu(true)
                : resultMenuOpen
                  ? () => setResultMenu(true)
                  : planCardWaits
                    ? () => setPlanCardFocused(true)
                    : model.onEmptySubmit
            }
            emptyAnswerNotice={recoveryPromptOpen ? RECOVERY_EMPTY_ENTER_NOTICE : undefined}
            onRuntimeCommand={model.handleRuntimeCommand}
            commands={commands}
            mode={planCardWaits ? 'normal' : model.inputMode.mode}
            inputHint={
              stopMenuOpen
                ? STOP_SHEET_COMPOSER_HINT
                : recoveryPromptOpen && recoveryIssue !== null
                  ? recoveryComposerHint(recoveryIssue, recoveryMenuFocused, recoveryStepReadsNone)
                  : resultMenuFocused
                    ? RESULT_MENU_COMPOSER_HINT
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
            waitingForUser={model.inputMode.mode !== 'normal' || model.promptPending}
            buildBlockShown={progressRows > 0}
            keepPlaceholderWhileFocused={
              recoveryPromptOpen || model.atRestRecord !== undefined || model.applying
            }
            {...(model.promptPending
              ? {
                  menuFocused: gateFocused,
                  onToggleMenu: () => {
                    setGateMenu(true);
                  },
                }
              : recoveryPromptOpen
                ? {
                    menuFocused: recoveryMenuFocused,
                    onToggleMenu: () => {
                      setRecoveryMenu(!recoveryMenuFocused);
                    },
                  }
                : resultMenuOpen
                  ? {
                      menuFocused: resultMenuFocused,
                      onToggleMenu: () => {
                        setResultMenu(!resultMenuFocused);
                      },
                    }
                  : planCardWaits
                    ? { onToggleMenu: () => setPlanCardFocused(true) }
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
        height={stopMenuOpen || resultMenuOpen ? 0 : promptBoxRows}
        overflow="hidden"
        flexDirection="column"
        flexShrink={0}
        paddingX={WORKFLOW_GUTTER_X}
      >
        {!stopMenuOpen && (model.promptPending || reviewArtifact !== null) && (
          <ApprovalPrompt
            clampedBoxRows={promptBoxRows}
            focused={gateFocused}
            queues={isQueuePhase(model.phase)}
            {...(reviewArtifact === null
              ? {}
              : {
                  review: {
                    artifact: reviewArtifact,
                    confirms: reviewConfirms,
                    budgetRows: reviewBudgetRows,
                    selectedIndex: reviewSelected,
                    draft: reviewDraft,
                    focused: planCardFocused,
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
            onRecoveryFocusChange={setRecoveryMenu}
            onRecoveryResolve={(answer) =>
              model.inputMode.resolve({ ...plainAnswer(answer), row: true })
            }
            questions={plannerQuestions}
            planner={
              structuredQuestion
                ? {
                    disabled: keysHeldAbove,
                    onAnswer: answerQuestion,
                    onCompose: composeAnswer,
                    onDecide: decideQuestions,
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
