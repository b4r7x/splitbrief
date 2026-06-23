import { useState, useEffect } from 'react';
import { Box, Text, type Key } from 'ink';
import { MultilineInput } from '../input/multiline-input.js';
import { CommandCompletionMenu } from './completion/command/menu.js';
import { ReferenceCompletionMenu } from './completion/reference/menu.js';
import { AttachmentChips } from './attachments.js';
import { useCommandCompletion } from './completion/command/hook.js';
import { useReferenceCompletion } from './completion/reference/hook.js';
import { useTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { completionStore } from '../../stores/ui/completion.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { projectFilesStore } from '../../stores/ui/project-files.js';
import { configStore } from '../../stores/project/config.js';
import { listProjectFiles } from '../../lib/file-listing.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../../core/paths.js';
import { useStores } from '../../stores/use-stores.js';
import { wrapHard } from '../../utils/wrap.js';
import type { Screen } from '../../core/navigation/types.js';
import type { InputMode } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useHistory } from './use-history.js';
import { attachImage } from '../../stores/workflow/attachments.js';
import { computeCompletionOverlayRows, computeCompletionCap } from './completion/layout.js';

const MAX_REFERENCE_SUGGESTIONS = 8;
const ELLIPSIS = '\u2026';
const RESUME_INTERRUPTED_PREFIX = 'Cannot resume "';
const RESUME_INTERRUPTED_SUFFIX = '": interrupted before it made progress \u2014 start it again.';
const SESSION_FAILED_PREFIX = 'Session "';
const SESSION_FAILED_SUFFIX = '" failed without a summary to display';

function borderColorForMode(
  mode: InputMode,
  theme: { planner: string; warning: string; border: string },
): string {
  if (mode === 'review') return theme.planner;
  if (mode === 'question') return theme.warning;
  return theme.border;
}

function placeholderForMode(mode: InputMode, hint?: string): string {
  if (hint) return hint;
  if (mode === 'review') return 'approve | Ctrl+E/e edit | comment ... | quit';
  if (mode === 'question') return 'type your answer...';
  return 'describe your feature...';
}

const SESSIONS_REL_DIR = `${DIPTYCH_DIR}/${SESSIONS_DIR}`;
const SESSIONS_EXCLUDE = new RegExp(`(?:^|/)${SESSIONS_REL_DIR.replace(/[.]/g, '\\$&')}/`);

export interface FeedbackMessageParts {
  prefix: string;
  title: string;
  suffix: string;
}

type FeedbackMessageInput = FeedbackMessageParts | string;

function fitsDisplayWidth(text: string, maxWidth: number): boolean {
  if (maxWidth <= 0) return text.length === 0;
  return !wrapHard(text, maxWidth).includes('\n');
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (fitsDisplayWidth(text, maxWidth)) return text;
  if (!fitsDisplayWidth(ELLIPSIS, maxWidth)) return '';

  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join('')}${ELLIPSIS}`;
    if (fitsDisplayWidth(candidate, maxWidth)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${chars.slice(0, low).join('')}${ELLIPSIS}`;
}

function matchKnownFeedbackMessage(
  message: string,
  prefix: string,
  suffix: string,
): FeedbackMessageParts | null {
  if (!message.startsWith(prefix) || !message.endsWith(suffix)) return null;
  return {
    prefix,
    title: message.slice(prefix.length, message.length - suffix.length),
    suffix,
  };
}

function structureKnownFeedbackMessage(message: string): FeedbackMessageInput {
  return (
    matchKnownFeedbackMessage(message, RESUME_INTERRUPTED_PREFIX, RESUME_INTERRUPTED_SUFFIX) ??
    matchKnownFeedbackMessage(message, SESSION_FAILED_PREFIX, SESSION_FAILED_SUFFIX) ??
    message
  );
}

export function fitFeedbackMessage(message: FeedbackMessageInput, width: number): string {
  const text =
    typeof message === 'string' ? message : `${message.prefix}${message.title}${message.suffix}`;
  if (!Number.isFinite(width)) return text;

  const max = Math.max(0, Math.floor(width));
  if (fitsDisplayWidth(text, max)) return text;
  if (typeof message === 'string') return truncateToDisplayWidth(message, max);

  const emptyTitle = `${message.prefix}${message.suffix}`;
  if (!fitsDisplayWidth(emptyTitle, max)) return truncateToDisplayWidth(text, max);

  const ellipsizedTitle = `${message.prefix}${ELLIPSIS}${message.suffix}`;
  if (!fitsDisplayWidth(ellipsizedTitle, max)) return emptyTitle;

  const chars = Array.from(message.title);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${message.prefix}${chars.slice(0, mid).join('')}${ELLIPSIS}${
      message.suffix
    }`;
    if (fitsDisplayWidth(candidate, max)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${message.prefix}${chars.slice(0, low).join('')}${ELLIPSIS}${message.suffix}`;
}

async function readProjectFiles(projectDir: string): Promise<string[]> {
  if (!projectDir) return [];
  try {
    return await listProjectFiles(projectDir, {
      excludePatterns: [SESSIONS_EXCLUDE],
      skipRelativeDirs: [SESSIONS_REL_DIR],
    });
  } catch {
    return [];
  }
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
  onEmptySubmit?: (() => void) | undefined;
  onEditShortcut?: (() => void) | undefined;
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
  onEmptySubmit,
  onEditShortcut,
}: ComposerProps) {
  const theme = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const [{ projectDir, config }] = useStores(configStore);
  const [{ message: feedbackMessage, isError: feedbackIsError }] = useStores(feedbackStore);
  const inputColumns = Math.max(1, (width ?? cols) - 6);
  const [value, setValue] = useState('');
  const [visibleRows, setVisibleRows] = useState(1);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const persistTranscript = config?.workflow.persistTranscript ?? true;

  const refreshEpoch = projectFilesStore.use((s) => s.refreshEpoch);

  const { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, onChange } = useHistory({
    disabled,
    value,
    setValue,
    currentScreen,
    persistTranscript,
  });

  const completionValue = mode === 'normal' ? value : '';
  const command = useCommandCompletion({
    commands,
    currentScreen,
    value: completionValue,
    setValue: onChange,
    onRuntimeCommand,
    disabled,
  });

  const reference = useReferenceCompletion({
    files: projectFiles,
    value: completionValue,
    setValue: onChange,
    disabled,
  });

  const showCommandSuggestions = command.showSuggestions;
  const showReferenceSuggestions = reference.showSuggestions && !showCommandSuggestions;

  const handleFileDrop = (path: string) => {
    const result = attachImage(path, projectDir);
    if (result.ok) {
      feedbackStore.setMessage(`Attached: ${result.path}`);
    } else {
      feedbackStore.setError(`Cannot attach: ${result.reason}`);
    }
  };

  const handleSubmit = (text: string) => {
    if (mode !== 'normal') {
      onSubmit(text);
      setValue('');
      resetHistory();
      bumpEpoch();
      return;
    }

    if (showCommandSuggestions || showReferenceSuggestions) return;
    const trimmed = text.trim();
    if (!trimmed) {
      onEmptySubmit?.();
      return;
    }

    inputHistoryStore.pushSubmission(trimmed, { currentScreen, persistTranscript });

    if (trimmed.startsWith('/')) {
      onRuntimeCommand(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setValue('');
    resetHistory();
    bumpEpoch();
  };

  const isEditShortcut = (input: string, key: Key): boolean =>
    mode === 'review' && key.ctrl && input === 'e';

  const handleInputBoundaryNavigate = (direction: 'up' | 'down') => {
    if (showCommandSuggestions || showReferenceSuggestions) return true;
    return handleBoundaryNavigate(direction);
  };

  const completionCap = computeCompletionCap(rows, visibleRows);
  const referenceSuggestionsCap = Math.min(MAX_REFERENCE_SUGGESTIONS, completionCap);
  const commandOverlayRows = showCommandSuggestions
    ? computeCompletionOverlayRows({
        itemCount: command.filtered.length,
        selectedIndex: command.selectedIndex,
        maxVisible: completionCap,
        hasFuzzyMatch: command.fuzzyMatch !== null,
      })
    : 0;
  const referenceOverlayRows = showReferenceSuggestions
    ? computeCompletionOverlayRows({
        itemCount: reference.filtered.length,
        selectedIndex: reference.selectedIndex,
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
          structureKnownFeedbackMessage(feedbackMessage),
          Math.max(1, width ?? cols),
        )
      : null;

  useEffect(() => {
    let active = true;
    void readProjectFiles(projectDir).then((files) => {
      if (active) setProjectFiles(files);
    });
    return () => {
      active = false;
    };
  }, [projectDir, refreshEpoch]);

  useEffect(() => {
    inputHeightStore.setRows(visibleRows + 2);
  }, [visibleRows]);

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
            <Text color={feedbackIsError ? theme.error : theme.info} wrap="truncate-end">
              {feedbackLine}
            </Text>
          ) : showHomeHint ? (
            <Text color={theme.textDim}>{homeHint}</Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
      )}
      <AttachmentChips />
      <Box flexDirection="column" width="100%" overflow="visible">
        <Box
          borderStyle="round"
          borderColor={borderColorForMode(mode, theme)}
          paddingX={1}
          width="100%"
          minHeight={3}
          flexShrink={0}
        >
          <Text color={theme.accent}>&gt; </Text>
          <Box flexGrow={1} overflow="hidden">
            <MultilineInput
              key={`${command.inputKey}:${reference.inputKey}:${inputEpoch}`}
              value={value}
              onChange={onChange}
              onSubmit={handleSubmit}
              onFileDrop={handleFileDrop}
              columns={inputColumns}
              focus={!disabled}
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
