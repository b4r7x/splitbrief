import { useEffect, useRef, useState } from 'react';
import { Box, Text, type Key } from 'ink';
import { MultilineInput } from '../input/multiline-input.js';
import { isTextEntryInput, isUnmodifiedYInput } from '../../lib/terminal/text-entry.js';
import { CommandCompletionMenu } from './completion/command/menu.js';
import { ReferenceCompletionMenu } from './completion/reference/menu.js';
import { AttachmentChips, attachmentChipRows, expandPastes } from './attachments.js';
import { useCommandCompletion } from './completion/command/hook.js';
import { useReferenceCompletion } from './completion/reference/hook.js';
import { useTheme, type Theme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { completionStore } from '../../stores/ui/completion.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { focusStore } from '../../stores/ui/focus.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import { useStores } from '../../stores/use-stores.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import type { Screen } from '../../core/navigation/types.js';
import type { InputMode } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useHistory } from './use-history.js';
import { attachImage, attachmentsStore } from '../../stores/workflow/attachments.js';
import { computeCompletionOverlayRows, computeCompletionCap } from './completion/layout.js';
import { glyph } from '../../lib/glyphs.js';
import {
  fitFeedbackMessage,
  matchKnownFeedbackMessage,
  type FeedbackMessageInput,
} from './feedback-fit.js';
import { useProjectFiles } from './use-project-files.js';
import { usePasteDrafts } from './use-paste-drafts.js';
import { useHintZones } from './use-hint-zones.js';

const MAX_REFERENCE_SUGGESTIONS = 8;
const RESUME_INTERRUPTED_PREFIX = 'Cannot resume "';
const RESUME_INTERRUPTED_SUFFIX = '": interrupted before it made progress \u2014 start it again.';
const SESSION_FAILED_PREFIX = 'Session "';
const SESSION_FAILED_SUFFIX = '" failed without a summary to display';

function promptColorForMode(
  mode: InputMode,
  theme: Pick<Theme, 'accent' | 'planner' | 'warning'>,
): string {
  if (mode === 'review') return theme.planner;
  if (mode === 'question') return theme.warning;
  return theme.accent;
}

function placeholderForMode(mode: InputMode, hint?: string): string {
  if (hint) return hint;
  if (mode === 'review') return 'approve, comment, or edit…';
  if (mode === 'question') return 'type your answer…';
  return 'Describe a change…';
}

function structureKnownFeedbackMessage(message: string): FeedbackMessageInput {
  return (
    matchKnownFeedbackMessage(message, RESUME_INTERRUPTED_PREFIX, RESUME_INTERRUPTED_SUFFIX) ??
    matchKnownFeedbackMessage(message, SESSION_FAILED_PREFIX, SESSION_FAILED_SUFFIX) ??
    message
  );
}

function resetComposerDraft(actions: {
  setValue: (value: string) => void;
  clearPastes: () => void;
  resetHistory: () => void;
  bumpEpoch: () => void;
}): void {
  actions.setValue('');
  actions.clearPastes();
  actions.resetHistory();
  actions.bumpEpoch();
}

export interface ComposerBoxHints {
  keys: string;
  cost?: string | undefined;
  costTone?: 'text' | 'warning' | 'error' | undefined;
}

interface ComposerProps {
  onSubmit: (text: string) => void;
  onRuntimeCommand: (command: string) => void;
  commands: RuntimeCommandDef[];
  mode: InputMode;
  hint: string;
  currentScreen: Screen;
  width?: number;
  disabled?: boolean;
  homeHint?: string | undefined;
  boxHints?: ComposerBoxHints | undefined;
  onEmptySubmit?: (() => void) | undefined;
  onEditShortcut?: (() => void) | undefined;
  onReviewBoundaryNavigate?: ((direction: 'up' | 'down') => boolean | undefined) | undefined;
  onReviewInteraction?: (() => void) | undefined;
  reviewYankActive?: boolean | undefined;
  boxLeftOffset?: number | undefined;
  questionEpoch?: number | undefined;
  inputPaddingX?: number | undefined;
}

function boxHintCostColor(
  tone: ComposerBoxHints['costTone'],
  theme: Pick<Theme, 'text' | 'warning' | 'error'>,
): string {
  if (tone === 'error') return theme.error;
  if (tone === 'warning') return theme.warning;
  return theme.text;
}

export function Composer({
  onSubmit,
  onRuntimeCommand,
  commands,
  mode,
  hint,
  currentScreen,
  width,
  disabled,
  homeHint,
  boxHints,
  onEmptySubmit,
  onEditShortcut,
  onReviewBoundaryNavigate,
  onReviewInteraction,
  reviewYankActive = false,
  boxLeftOffset,
  questionEpoch,
  inputPaddingX = 1,
}: ComposerProps) {
  const theme = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const [{ projectDir, config }] = useStores(configStore);
  const [{ message: feedbackMessage, isError: feedbackIsError }] = useStores(feedbackStore);
  const [{ pending: pendingAttachments }] = useStores(attachmentsStore);
  const inputColumns = Math.max(1, (width ?? cols) - 4 - inputPaddingX * 2);
  const [value, setValue] = useState('');
  const [visibleRows, setVisibleRows] = useState(1);
  const previousModeRef = useRef(mode);
  const persistTranscript = config?.workflow.persistTranscript ?? true;

  const briefFocusHeld =
    focusStore.use((focus) => focus?.region === 'brief') && currentScreen === 'workflow';

  const { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, onChange, historyActive } =
    useHistory({
      disabled,
      value,
      setValue,
      currentScreen,
      persistTranscript,
    });

  const handleDraftChange = (next: string) => {
    onReviewInteraction?.();
    onChange(next);
  };
  const { pastes, handleChange, clearPastes } = usePasteDrafts({
    value,
    onChange: handleDraftChange,
  });
  const clearDraft = (): void => {
    resetComposerDraft({ setValue, clearPastes, resetHistory, bumpEpoch });
  };
  const chipRows = attachmentChipRows(pastes, pendingAttachments, cols);
  const projectFiles = useProjectFiles(projectDir);

  const completionValue = mode === 'normal' ? value : '';
  const command = useCommandCompletion({
    commands,
    currentScreen,
    value: completionValue,
    setValue: onChange,
    onRuntimeCommand,
    disabled,
    suppressed: historyActive,
  });

  const reference = useReferenceCompletion({
    files: projectFiles,
    value: completionValue,
    setValue: onChange,
    disabled,
    suppressed: historyActive,
  });

  const showCommandSuggestions = command.showSuggestions;
  const showReferenceSuggestions = reference.showSuggestions && !showCommandSuggestions;

  const handleFileDrop = (path: string) => {
    const route = routerStore.get();
    if (route.screen === 'workflow' && route.execution.kind === 'attached') {
      feedbackStore.setError('Attachments are unavailable while attached.');
      return;
    }
    const result = attachImage(path, projectDir);
    if (result.ok) {
      onReviewInteraction?.();
      feedbackStore.setMessage(`Attached: ${result.path}`);
    } else {
      feedbackStore.setError(`Cannot attach: ${result.reason}`);
    }
  };

  const handleSubmit = (text: string) => {
    if (mode !== 'normal') {
      onSubmit(expandPastes(text, pastes));
      clearDraft();
      return;
    }

    if (showCommandSuggestions || showReferenceSuggestions) return;
    const trimmed = text.trim();
    if (!trimmed && pastes.length === 0) {
      onEmptySubmit?.();
      return;
    }

    if (trimmed) inputHistoryStore.pushSubmission(trimmed, { currentScreen, persistTranscript });

    if (trimmed.startsWith('/')) {
      onRuntimeCommand(trimmed);
    } else {
      onSubmit(expandPastes(trimmed, pastes));
    }
    clearDraft();
  };

  const isEditShortcut = (input: string, key: Key): boolean =>
    mode === 'review' && key.ctrl && input === 'e';

  const handleInputBoundaryNavigate = (direction: 'up' | 'down') => {
    if (showCommandSuggestions || showReferenceSuggestions) return true;
    if (mode !== 'normal') {
      if (mode === 'review' && value.length === 0) onReviewBoundaryNavigate?.(direction);
      return true;
    }
    return handleBoundaryNavigate(direction);
  };
  const shouldHandleComposerInput = (input: string, key: Key): boolean =>
    !briefFocusHeld ||
    (mode === 'review' &&
      (!reviewYankActive || !isUnmodifiedYInput(input, key)) &&
      isTextEntryInput(input, key));
  const handleComposerInputAccepted = (): void => {
    if (briefFocusHeld) focusStore.clear();
  };

  const hintBoxWidth = width ?? cols;
  const registerHintZones =
    currentScreen === 'workflow' &&
    !disabled &&
    (width === undefined || boxLeftOffset !== undefined);
  const hintBoxLeft = 1 + (boxLeftOffset ?? 0);
  const hintDisplay = useHintZones({
    boxHints,
    hintBoxWidth,
    inputPaddingX,
    visibleRows,
    rows,
    registerHintZones,
    hintBoxLeft,
  });

  const completionCap = computeCompletionCap(rows, visibleRows);
  const referenceSuggestionsCap = Math.min(MAX_REFERENCE_SUGGESTIONS, completionCap);
  const commandOverlayRows = showCommandSuggestions
    ? computeCompletionOverlayRows({
        itemCount: command.filtered.length,
        maxVisible: completionCap,
        hasFuzzyMatch: command.fuzzyMatch !== null,
        hasEmptyMessage: command.filtered.length === 0 && command.fuzzyMatch === null,
      })
    : 0;
  const referenceOverlayRows = showReferenceSuggestions
    ? computeCompletionOverlayRows({
        itemCount: reference.filtered.length,
        maxVisible: referenceSuggestionsCap,
      })
    : 0;
  const reserveHomeHint = currentScreen === 'home';
  const showHomeHint =
    reserveHomeHint &&
    homeHint !== undefined &&
    !showCommandSuggestions &&
    !showReferenceSuggestions;
  const showHomeFeedback = showHomeHint && feedbackMessage !== null;
  const feedbackLine =
    showHomeFeedback && feedbackMessage !== null
      ? fitFeedbackMessage(
          structureKnownFeedbackMessage(sanitizeTerminalDisplayText(feedbackMessage)),
          Math.max(1, width ?? cols),
        )
      : null;

  useEffect(() => {
    inputHeightStore.setRows(visibleRows + 2 + chipRows);
  }, [visibleRows, chipRows]);

  useEffect(() => {
    const leavingQuestion = previousModeRef.current === 'question' && mode !== 'question';
    previousModeRef.current = mode;
    if (mode !== 'question' && !leavingQuestion) return;
    resetComposerDraft({ setValue, clearPastes, resetHistory, bumpEpoch });
  }, [mode, questionEpoch]);

  const completionOpen = showCommandSuggestions || showReferenceSuggestions;
  useEffect(() => {
    completionStore.setOpen(completionOpen);
    return () => completionStore.setOpen(false);
  }, [completionOpen]);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0} overflow="visible">
      {reserveHomeHint && (
        <Box justifyContent="center" height={1}>
          {feedbackLine !== null ? (
            <Text color={feedbackIsError ? theme.error : theme.textDim} wrap="truncate-end">
              {feedbackLine}
            </Text>
          ) : showHomeHint ? (
            <Text color={theme.textDim}>{homeHint}</Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
      )}
      <AttachmentChips pastes={pastes} />
      <Box flexDirection="column" width="100%" overflow="visible">
        <Box
          borderStyle="round"
          borderColor={theme.border}
          paddingX={inputPaddingX}
          width="100%"
          minHeight={3}
          flexShrink={0}
        >
          <Text color={promptColorForMode(mode, theme)} dimColor={mode === 'review'}>
            {`${glyph('prompt')} `}
          </Text>
          <Box flexGrow={1} overflow="hidden">
            <MultilineInput
              key={`${command.inputKey}:${reference.inputKey}:${inputEpoch}`}
              value={value}
              onChange={handleChange}
              onSubmit={handleSubmit}
              onFileDrop={handleFileDrop}
              columns={inputColumns}
              focus={!disabled && !briefFocusHeld}
              isActive={!disabled && (!briefFocusHeld || mode === 'review')}
              shouldHandleInput={shouldHandleComposerInput}
              onInputAccepted={handleComposerInputAccepted}
              placeholder={placeholderForMode(mode, hint)}
              rows={1}
              maxRows={6}
              onVisibleRowsChange={setVisibleRows}
              keyBindings={{
                submit: (key: { return: boolean; shift: boolean }) => key.return && !key.shift,
                newline: (key: { return: boolean; shift: boolean }) => key.return && key.shift,
                ...(onEditShortcut ? { shortcut: isEditShortcut } : {}),
              }}
              {...(onEditShortcut ? { onShortcut: onEditShortcut } : {})}
              onBoundaryNavigate={handleInputBoundaryNavigate}
            />
          </Box>
          {hintDisplay && (hintDisplay.keys.length > 0 || hintDisplay.cost !== undefined) && (
            <Box flexShrink={0} marginLeft={2}>
              {hintDisplay.keys.length > 0 && <Text color={theme.textDim}>{hintDisplay.keys}</Text>}
              {hintDisplay.cost !== undefined && (
                <Text color={boxHintCostColor(boxHints?.costTone, theme)}>
                  {hintDisplay.keys.length > 0 ? `  ${hintDisplay.cost}` : hintDisplay.cost}
                </Text>
              )}
            </Box>
          )}
        </Box>
        {showCommandSuggestions && (
          <Box position="absolute" width="100%" marginTop={-commandOverlayRows}>
            <CommandCompletionMenu
              filtered={command.filtered}
              selectedIndex={command.selectedIndex}
              fuzzyMatch={command.fuzzyMatch}
              maxVisible={completionCap}
            />
          </Box>
        )}
        {showReferenceSuggestions && (
          <Box position="absolute" width="100%" marginTop={-referenceOverlayRows}>
            <ReferenceCompletionMenu
              filtered={reference.filtered}
              selectedIndex={reference.selectedIndex}
              maxVisible={referenceSuggestionsCap}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
