import { useEffect, type ReactNode } from 'react';
import type { DraftSubmission } from '../../../core/composer/submission.js';
import { Box, useInput } from 'ink';
import type { RuntimeCommandDef } from '../../../core/runtime/commands/types.js';
import type { InputMode } from '../../../core/navigation/types.js';
import { Composer, type ComposerBoxHints } from '../../../components/composer/composer.js';
import { Header } from './header.js';
import { FeedbackRow } from './feedback-row.js';
import { InputFooter } from './input-footer.js';
import { Divider } from '../../../components/divider.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { queuePlaceholder, type ComposerBoxHintOverride } from '../input-hints.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import type { SeatLineSpan } from '../../../core/crew/identity.js';
import { getChromeContentWidth, WORKFLOW_GUTTER_X, type RailForm } from '../layout/chrome-rows.js';
import type { readClipboardImage as readSystemClipboardImage } from '../../../core/attachments/clipboard-image.js';
import type { listProjectFiles as listFiles } from '../../../lib/file-listing.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { selectRunningBrief, tasksStore } from '../../../stores/workflow/tasks.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import {
  operationsStore,
  selectScheduledReview,
} from '../../../stores/workflow/operations/state.js';
import { requestSteer } from '../handlers.js';
import { composerDraftStore } from '../../../stores/ui/composer-draft.js';
import { settleSlashHandoff, startSlashHandoff } from '../slash-handoff.js';

export function WorkflowHeader({
  scrollAboveLabel = '',
  railForm,
  buildBlockShown,
  stages,
  seatLine,
  children,
}: {
  scrollAboveLabel?: string;
  railForm?: RailForm | undefined;
  buildBlockShown?: boolean | undefined;
  /** A run at rest names its own stages and the crew that actually ran it. */
  stages?: readonly RailStageState[] | undefined;
  seatLine?: readonly SeatLineSpan[] | undefined;
  /** Chrome rows that belong above the divider, so the body starts at one boundary. */
  children?: ReactNode;
}) {
  const cols = terminalSizeStore.use((s) => s.cols);
  // The rail row and the build block sit inside the gutter; the divider under them bleeds edge to
  // edge.
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" paddingX={WORKFLOW_GUTTER_X}>
        <Header
          railForm={railForm}
          buildBlockShown={buildBlockShown}
          {...(stages !== undefined && { stages })}
          {...(seatLine !== undefined && { seatLine })}
        />
        {children}
      </Box>
      <Divider width={cols} label={scrollAboveLabel} tone="textDim" />
    </Box>
  );
}

export function WorkflowFooter({
  handleInput,
  onEmptySubmit,
  onRuntimeCommand,
  commands,
  mode,
  inputHint,
  feedbackHint,
  boxHintOverride,
  commandsOnly,
  byline,
  disabled,
  compactInput = false,
  beforeComposer,
  onEditShortcut,
  onReviewBoundaryNavigate,
  onReviewInteraction,
  reviewEpoch,
  questionEpoch,
  waitingForUser = false,
  buildBlockShown = false,
  menuFocused = false,
  onToggleMenu,
  onTakeKeys,
  keepPlaceholderWhileFocused,
  questionPanelFocused = false,
  onReturnToQuestion,
  readClipboardImage,
  listProjectFiles,
}: {
  handleInput: (submission: Extract<DraftSubmission, { ok: true }>) => void;
  onEmptySubmit?: (() => void) | undefined;
  onRuntimeCommand: (command: string) => void;
  commands: RuntimeCommandDef[];
  mode: InputMode;
  inputHint: string;
  feedbackHint?: string | undefined;
  boxHintOverride?: ComposerBoxHintOverride | undefined;
  /** A stopped run that cannot be resumed has nothing to take but commands. */
  commandsOnly?: boolean | undefined;
  /** The byline of a run at rest, which has no live status to derive one from. */
  byline?: Parameters<typeof InputFooter>[0]['byline'];
  disabled: boolean;
  compactInput?: boolean | undefined;
  beforeComposer?: ReactNode;
  onEditShortcut?: (() => void) | undefined;
  onReviewBoundaryNavigate?: ((direction: 'up' | 'down') => boolean | undefined) | undefined;
  onReviewInteraction?: (() => void) | undefined;
  reviewEpoch?: number | undefined;
  questionEpoch?: number | undefined;
  waitingForUser?: boolean | undefined;
  /** The build block is on screen above the body, and its freshness line states the silence. */
  buildBlockShown?: boolean | undefined;
  questionPanelFocused?: boolean | undefined;
  onReturnToQuestion?: (() => void) | undefined;
  menuFocused?: boolean | undefined;
  onToggleMenu?: (() => void) | undefined;
  /** Lets go of the panel that holds the keys, so a typed slash command goes to the composer. */
  onTakeKeys?: (() => void) | undefined;
  /** The placeholder names what the composer takes on either side of the menu toggle, so focus keeps it. */
  keepPlaceholderWhileFocused?: boolean | undefined;
  readClipboardImage?: typeof readSystemClipboardImage | undefined;
  listProjectFiles?: typeof listFiles | undefined;
}) {
  // The in-box hint is a key cluster and nothing else: what a run spent is named in /usage, and how
  // it ended in the rail and the closed block, not beside the caret.
  const boxHints: ComposerBoxHints = { keys: boxHintOverride?.keys ?? '' };
  const composerSession = mode === 'review' ? `review:${reviewEpoch ?? 0}` : 'non-review';
  // The width the composer box actually renders at — the terminal inside the gutter — so the
  // input's own wrap math budgets the same cells the box paints.
  const composerWidth = getChromeContentWidth(terminalSizeStore.use((s) => s.cols));
  const phase = lifecycleStore.use((state) => state.phase);
  const running = lifecycleStore.use((state) => state.status === 'running');
  const steerableSeat = lifecycleStore.use((state) => state.steerableCall?.seat ?? null);
  const taskId = tasksStore.use((state) => selectRunningBrief(state, phase).current?.id);
  const stopping = stopStore.use((state) => state.intent !== 'none');
  const reviewing = operationsStore.use(selectScheduledReview);
  const placeholder = queuePlaceholder({
    phase,
    inputMode: mode,
    running,
    stopping,
    reviewing,
    taskId,
    steerableSeat,
  });
  // A slash typed while a panel holds the keys is a command: the panel lets go and the composer takes
  // the whole read, so a pasted `/settings` arrives in one piece.
  useInput((input) => {
    if (onTakeKeys === undefined || !input.startsWith('/')) return;
    startSlashHandoff();
    onTakeKeys();
    composerDraftStore.requestCommand(input);
  });
  useEffect(() => {
    settleSlashHandoff();
  });
  const footer = (
    <Box flexDirection="column" paddingX={WORKFLOW_GUTTER_X}>
      <FeedbackRow
        keyHint={feedbackHint ?? undefined}
        inputHint={inputHint}
        panelBelow={beforeComposer !== undefined}
      />
      {beforeComposer}
      <Composer
        maxRows={compactInput ? 1 : 6}
        key={composerSession}
        width={composerWidth}
        onSubmit={handleInput}
        onSendNow={(submission) => requestSteer(submission.message)}
        readClipboardImage={readClipboardImage}
        listProjectFiles={listProjectFiles}
        onEmptySubmit={onEmptySubmit}
        onRuntimeCommand={onRuntimeCommand}
        commands={commands}
        mode={mode}
        hint={inputHint === '' ? (placeholder ?? '') : inputHint}
        keepPlaceholderWhileFocused={keepPlaceholderWhileFocused}
        commandsOnly={commandsOnly}
        currentScreen="workflow"
        disabled={disabled || menuFocused || questionPanelFocused}
        {...((onReturnToQuestion ?? onToggleMenu) !== undefined
          ? { onTab: onReturnToQuestion ?? onToggleMenu }
          : {})}
        boxHints={boxHints}
        questionEpoch={questionEpoch}
        inputPaddingX={1}
        {...(onEditShortcut ? { onEditShortcut } : {})}
        {...(onReviewBoundaryNavigate ? { onReviewBoundaryNavigate } : {})}
        {...(onReviewInteraction ? { onReviewInteraction } : {})}
      />
      <InputFooter
        waiting={waitingForUser}
        buildBlockShown={buildBlockShown}
        {...(byline !== undefined && { byline })}
      />
    </Box>
  );
  return footer;
}
