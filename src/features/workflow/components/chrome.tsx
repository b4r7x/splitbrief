import type { ReactNode } from 'react';
import type { RuntimeCommandDef } from '../../../core/runtime/commands/types.js';
import type { InputMode } from '../../../core/navigation/types.js';
import { Composer, type ComposerBoxHints } from '../../../components/composer/composer.js';
import { Header } from './header.js';
import { FeedbackRow } from './feedback-row.js';
import { InputFooter } from './input-footer.js';
import { Divider } from '../../../components/divider.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useFieldSessionOwned } from '../../editor/use-field-session-owned.js';
import { glyph } from '../../../lib/glyphs.js';
import type { ComposerBoxHintOverride } from '../input-hints.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import type { RailForm } from '../layout/chrome-rows.js';
import type { readClipboardImage as readSystemClipboardImage } from '../../../core/attachments/clipboard-image.js';
import type { listProjectFiles as listFiles } from '../../../lib/file-listing.js';

// The in-box hint is a key cluster and a done mark: what a run spent and how many tokens it took
// is named in /usage, not beside the caret.
function useComposerBoxHints(override?: ComposerBoxHintOverride | undefined): ComposerBoxHints {
  const complete = lifecycleStore.use((s) => s.phase === 'complete');
  const baseKeys = override?.keys ?? '';
  const keys = complete
    ? [baseKeys, glyph('check')].filter((part) => part.length > 0).join('  ')
    : baseKeys;
  return { keys };
}

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
  return (
    <>
      <Header
        startedAt={startedAt}
        railForm={railForm}
        {...(stages !== undefined && { stages })}
        {...(seatLine !== undefined && { seatLine })}
      />
      {children}
      <Divider width={cols} label={scrollAboveLabel} tone="textDim" />
    </>
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
  onEditShortcut,
  onReviewBoundaryNavigate,
  onReviewInteraction,
  reviewYankActive,
  reviewEpoch,
  questionEpoch,
  waitingForUser = false,
  recoveryMenuFocused = false,
  onToggleRecoveryMenu,
  readClipboardImage,
  listProjectFiles,
}: {
  handleInput: (text: string) => void;
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
  byline?: string | undefined;
  disabled: boolean;
  onEditShortcut?: (() => void) | undefined;
  onReviewBoundaryNavigate?: ((direction: 'up' | 'down') => boolean | undefined) | undefined;
  onReviewInteraction?: (() => void) | undefined;
  reviewYankActive?: boolean | undefined;
  reviewEpoch?: number | undefined;
  questionEpoch?: number | undefined;
  waitingForUser?: boolean | undefined;
  recoveryMenuFocused?: boolean | undefined;
  onToggleRecoveryMenu?: (() => void) | undefined;
  readClipboardImage?: typeof readSystemClipboardImage | undefined;
  listProjectFiles?: typeof listFiles | undefined;
}) {
  const boxHints = useComposerBoxHints(boxHintOverride);
  const fieldEditorOpen = useFieldSessionOwned();
  const composerSession = mode === 'review' ? `review:${reviewEpoch ?? 0}` : 'non-review';
  const footer = (
    <>
      <FeedbackRow inputHint={feedbackHint ?? inputHint} />
      <Composer
        key={composerSession}
        onSubmit={handleInput}
        readClipboardImage={readClipboardImage}
        listProjectFiles={listProjectFiles}
        onEmptySubmit={onEmptySubmit}
        onRuntimeCommand={onRuntimeCommand}
        commands={commands}
        mode={mode}
        hint={inputHint}
        commandsOnly={commandsOnly}
        currentScreen="workflow"
        disabled={disabled || fieldEditorOpen || recoveryMenuFocused}
        {...(onToggleRecoveryMenu !== undefined ? { onTab: onToggleRecoveryMenu } : {})}
        boxHints={boxHints}
        questionEpoch={questionEpoch}
        inputPaddingX={0}
        {...(onEditShortcut ? { onEditShortcut } : {})}
        {...(onReviewBoundaryNavigate ? { onReviewBoundaryNavigate } : {})}
        {...(onReviewInteraction ? { onReviewInteraction } : {})}
        reviewYankActive={reviewYankActive}
      />
      <InputFooter waiting={waitingForUser} {...(byline !== undefined && { byline })} />
    </>
  );
  return footer;
}
