import type { ReactNode } from 'react';
import { Box } from 'ink';
import type { RuntimeCommandDef } from '../../../core/runtime/commands/types.js';
import type { InputMode } from '../../../core/navigation/types.js';
import { Composer, type ComposerBoxHints } from '../../../components/composer/composer.js';
import { Header } from './header.js';
import { FeedbackRow } from './feedback-row.js';
import { InputFooter } from './input-footer.js';
import { Divider } from '../../../components/divider.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import type { ComposerBoxHintOverride } from '../input-hints.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import { getChromeContentWidth, WORKFLOW_GUTTER_X, type RailForm } from '../layout/chrome-rows.js';
import type { readClipboardImage as readSystemClipboardImage } from '../../../core/attachments/clipboard-image.js';
import type { listProjectFiles as listFiles } from '../../../lib/file-listing.js';

export function WorkflowHeader({
  startedAt,
  scrollAboveLabel = '',
  railForm,
  stages,
  seatLine,
  children,
}: {
  startedAt: string;
  scrollAboveLabel?: string;
  railForm?: RailForm | undefined;
  /** A run at rest names its own stages and the crew that actually ran it. */
  stages?: readonly RailStageState[] | undefined;
  seatLine?: string | undefined;
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
          startedAt={startedAt}
          railForm={railForm}
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
  placeholder,
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
  questionPanelFocused = false,
  onReturnToQuestion,
  readClipboardImage,
  listProjectFiles,
}: {
  handleInput: (text: string) => void;
  onEmptySubmit?: (() => void) | undefined;
  onRuntimeCommand: (command: string) => void;
  commands: RuntimeCommandDef[];
  mode: InputMode;
  inputHint: string;
  /** What the composer invites while no hint owns it; absent, the composer keeps its own words. */
  placeholder?: string | undefined;
  feedbackHint?: string | undefined;
  boxHintOverride?: ComposerBoxHintOverride | undefined;
  /** A stopped run that cannot be resumed has nothing to take but commands. */
  commandsOnly?: boolean | undefined;
  /** The byline of a run at rest, which has no live status to derive one from. */
  byline?: string | undefined;
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
        readClipboardImage={readClipboardImage}
        listProjectFiles={listProjectFiles}
        onEmptySubmit={onEmptySubmit}
        onRuntimeCommand={onRuntimeCommand}
        commands={commands}
        mode={mode}
        hint={inputHint === '' ? (placeholder ?? '') : inputHint}
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
