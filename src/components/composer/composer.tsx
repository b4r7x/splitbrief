import { useEffect, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { MultilineInput } from '../input/multiline-input.js';
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
import { useStores } from '../../stores/use-stores.js';
import type { Screen } from '../../core/navigation/types.js';
import type { InputMode } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useHistory } from './use-history.js';
import { attachImage, attachmentsStore, detachImage } from '../../stores/workflow/attachments.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { formatSeatIdentity } from '../../core/crew/identity.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { detectedModelFact, seatSupportsImages } from '../../core/runners/capabilities.js';
import { computeCompletionOverlayRows, computeCompletionCap } from './completion/layout.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { deriveHomeHintLines, noVisionFeedbackMessage } from './home-hint.js';
import { useProjectFiles } from './use-project-files.js';
import { usePasteDrafts } from './use-paste-drafts.js';
import { useHintZones } from './use-hint-zones.js';
import { useReviewKeys } from './use-review-keys.js';
import { useDraftSync } from './use-draft-sync.js';

const MAX_REFERENCE_SUGGESTIONS = 8;

// The prompt glyph is structure: it marks where typing goes, it does not name a category. Weight
// and position carry it, never hue — so normal and review draw the same mark. Question mode keeps
// its tone for now because the answer gate has no other cue at the caret; if that becomes a
// different glyph, this whole function goes.
function promptColorForMode(mode: InputMode, theme: Pick<Theme, 'text' | 'warning'>): string {
  if (mode === 'question') return theme.warning;
  return theme.text;
}

function placeholderForMode(mode: InputMode, hint?: string): string {
  if (hint) return hint;
  if (mode === 'review') return 'approve, comment, or edit…';
  if (mode === 'question') return 'type your answer…';
  return 'Describe a change…';
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
  submitKeepsDraft?: boolean;
  promptGlyph?: string | undefined;
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
  draftRestore?: Readonly<{ epoch: number; value: string }> | undefined;
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
  submitKeepsDraft,
  promptGlyph,
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
  draftRestore,
}: ComposerProps) {
  const theme = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const [{ projectDir, config }] = useStores(configStore);
  const [{ message: feedbackMessage, isError: feedbackIsError }] = useStores(feedbackStore);
  const [{ pending: pendingAttachments }] = useStores(attachmentsStore);
  const inputColumns = Math.max(1, (width ?? cols) - 4 - inputPaddingX * 2);
  const [value, setValue] = useState('');
  const [visibleRows, setVisibleRows] = useState(1);

  const briefFocusHeld =
    focusStore.use((focus) => focus?.region === 'brief') && currentScreen === 'workflow';

  const { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, onChange, historyActive } =
    useHistory({
      disabled,
      value,
      setValue,
      currentScreen,
    });

  const handleDraftChange = (next: string) => {
    onReviewInteraction?.();
    onChange(next);
  };
  const { pastes, handleChange, clearPastes } = usePasteDrafts({
    value,
    onChange: handleDraftChange,
  });
  const { clearDraft } = useDraftSync({
    mode,
    questionEpoch,
    draftRestore,
    actions: { setValue, clearPastes, resetHistory, bumpEpoch },
  });
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

  const detectionProviders = modelCacheStore.use((cache) => cache.detection.providers);
  const plannerSupportsImages =
    config !== null &&
    seatSupportsImages({
      runner: config.planner,
      detected: detectedModelFact(detectionProviders, config.planner),
    });

  const handleFileDrop = (path: string) => {
    const result = attachImage({ path, projectDir, supportsImages: plannerSupportsImages });
    if (result.ok) {
      onReviewInteraction?.();
      feedbackStore.setMessage(`Attached: ${result.path}`);
      return;
    }
    if (result.reason === 'no-vision' && config !== null) {
      const displayName = resolveSeatDisplayName(config.planner, 'planner', modelCacheStore);
      feedbackStore.setError(
        noVisionFeedbackMessage(formatSeatIdentity(config.planner, displayName)),
      );
      return;
    }
    feedbackStore.setError(`Cannot attach: ${result.reason}`);
  };

  const handleSubmit = (text: string) => {
    if (mode !== 'normal') {
      onSubmit(expandPastes(text, pastes));
      if (!submitKeepsDraft) clearDraft();
      return;
    }

    if (showCommandSuggestions || showReferenceSuggestions) return;
    const trimmed = text.trim();
    if (!trimmed && pastes.length === 0) {
      onEmptySubmit?.();
      return;
    }

    if (trimmed) inputHistoryStore.pushSubmission(trimmed, { currentScreen });

    if (trimmed.startsWith('/')) {
      onRuntimeCommand(trimmed);
      clearDraft();
      return;
    }

    onSubmit(expandPastes(trimmed, pastes));
    if (!submitKeepsDraft) clearDraft();
  };

  const textDraftEmpty = value.length === 0 && pastes.length === 0;

  const { shouldHandleComposerInput } = useReviewKeys({
    mode,
    disabled,
    briefFocusHeld,
    draftEmpty: textDraftEmpty && pendingAttachments.length === 0,
    reviewYankActive,
    onDraft: (text) => {
      handleDraftChange(text);
      bumpEpoch();
    },
    onCommand: onSubmit,
  });

  // Same discipline as the review keys: the chip pop only owns Backspace while there is
  // nothing typed for it to delete, so the moment the user types the key is text again.
  const attachmentPopArmed =
    mode === 'normal' &&
    !disabled &&
    !briefFocusHeld &&
    textDraftEmpty &&
    pendingAttachments.length > 0;

  useInput(
    (_input, key) => {
      if (!key.backspace && !key.delete) return;
      const last = pendingAttachments.at(-1);
      if (last === undefined || !detachImage()) return;
      feedbackStore.setMessage(`Detached: ${last.path}`);
    },
    { isActive: attachmentPopArmed },
  );

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
  const { feedbackLine, homeHintLine } = deriveHomeHintLines({
    active: reserveHomeHint && !showCommandSuggestions && !showReferenceSuggestions,
    homeHint,
    feedbackMessage,
    width: width ?? cols,
    dropEnabled: !disabled && plannerSupportsImages,
  });

  useEffect(() => {
    inputHeightStore.setRows(visibleRows + 2 + chipRows);
  }, [visibleRows, chipRows]);

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
          ) : homeHintLine !== null ? (
            <Text color={theme.textDim} wrap="truncate-end">
              {homeHintLine}
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
      )}
      <AttachmentChips pastes={pastes} />
      <Box flexDirection="column" width="100%" overflow="visible">
        <Box
          borderStyle={borderStyleFor('round')}
          borderColor={theme.border}
          paddingX={inputPaddingX}
          width="100%"
          minHeight={3}
          flexShrink={0}
        >
          <Text color={promptColorForMode(mode, theme)} dimColor={mode === 'review'}>
            {`${promptGlyph ?? glyph('prompt')} `}
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
