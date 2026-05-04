import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from '../input/multiline-input.js';
import { SlashSuggestions } from './slash-suggestions.js';
import { AtFileSuggestions } from './at-file-suggestions.js';
import { AttachmentChips } from './attachment-chips.js';
import { useSlashAutocomplete } from './use-slash-autocomplete.js';
import { useAtFileAutocomplete } from './use-at-file-autocomplete.js';
import { useTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { configStore } from '../../stores/project/config.js';
import { listProjectFiles } from '../../lib/file-listing.js';
import { useStores } from '../../stores/use-stores.js';
import type { InputMode, Screen } from '../../stores/navigation/router.js';
import type { SlashCommandDef } from '../../core/slash-commands/types.js';
import { useInputBarHistory } from './use-input-bar-history.js';
import { attachImage } from '../../stores/ui/attachments.js';
import { computeSuggestionsCap } from './slash-suggestions-height.js';

const MAX_AT_FILE_SUGGESTIONS = 8;

function borderColorForMode(mode: InputMode, theme: { planner: string; warning: string; border: string }): string {
  if (mode === 'review') return theme.planner;
  if (mode === 'question') return theme.warning;
  return theme.border;
}

function placeholderForMode(mode: InputMode, hint?: string): string {
  if (hint) return hint;
  if (mode === 'review') return 'approve / edit / comment ... / quit';
  if (mode === 'question') return 'type your answer...';
  return 'describe your feature...';
}

function readProjectFiles(projectDir: string): string[] {
  if (!projectDir) return [];
  try {
    return listProjectFiles(projectDir);
  } catch {
    return [];
  }
}

function isRefreshCommand(command: string): boolean {
  return command.trim() === '/refresh';
}

interface InputBarProps {
  onSubmit: (text: string) => void;
  onSlashCommand: (command: string) => void;
  commands: SlashCommandDef[];
  mode: InputMode;
  hint: string;
  currentScreen: Screen;
  width?: number;
  disabled?: boolean;
}

export function InputBar({
  onSubmit,
  onSlashCommand,
  commands,
  mode,
  hint,
  currentScreen,
  width,
  disabled,
}: InputBarProps) {
  const theme = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const [{ projectDir }] = useStores(configStore);
  const inputColumns = Math.max(1, (width ?? cols) - 6);
  const [value, setValue] = useState('');
  const [visibleRows, setVisibleRows] = useState(1);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);

  const refreshProjectFiles = () => {
    setProjectFiles(readProjectFiles(projectDir));
  };

  const { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, onChange } = useInputBarHistory({
    currentScreen,
    disabled,
    value,
    setValue,
  });

  const handleSlashCommand = (command: string) => {
    onSlashCommand(command);
    if (isRefreshCommand(command)) {
      refreshProjectFiles();
    }
  };

  const slash = useSlashAutocomplete({
    commands,
    currentScreen,
    value,
    setValue: onChange,
    onSlashCommand: handleSlashCommand,
    disabled,
  });

  const atFile = useAtFileAutocomplete({
    files: projectFiles,
    value,
    setValue: onChange,
    disabled,
  });

  const showSlashSuggestions = slash.showSuggestions;
  const showAtFileSuggestions = atFile.showSuggestions && !showSlashSuggestions;

  const handleFileDrop = (path: string) => {
    const projectDir = configStore.get().projectDir;
    const result = attachImage(path, projectDir);
    if (result.ok) {
      feedbackStore.setMessage(`Attached: ${result.path}`);
    } else {
      feedbackStore.setError(`Cannot attach: ${result.reason}`);
    }
  };

  const handleSubmit = (text: string) => {
    if (showSlashSuggestions || showAtFileSuggestions) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (currentScreen === 'home') {
      inputHistoryStore.push(trimmed);
    }

    if (trimmed.startsWith('/')) {
      handleSlashCommand(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setValue('');
    resetHistory();
    bumpEpoch();
  };

  const handleInputBoundaryNavigate = (direction: 'up' | 'down') => {
    if (showSlashSuggestions || showAtFileSuggestions) return true;
    return handleBoundaryNavigate(direction);
  };

  const suggestionsCap = computeSuggestionsCap(rows, visibleRows);
  const atFileSuggestionsCap = Math.min(MAX_AT_FILE_SUGGESTIONS, suggestionsCap);

  useEffect(() => {
    refreshProjectFiles();
  }, [projectDir]);

  useEffect(() => {
    const slashRows = showSlashSuggestions
      ? Math.min(slash.filtered.length || (slash.fuzzyMatch ? 1 : 0), suggestionsCap)
      : 0;
    const atRows = showAtFileSuggestions
      ? Math.min(atFile.filtered.length, atFileSuggestionsCap)
      : 0;
    const suggestionRows = Math.max(slashRows, atRows);
    inputHeightStore.setRows(visibleRows + 2 + suggestionRows);
  }, [
    slash.filtered.length,
    slash.fuzzyMatch,
    showSlashSuggestions,
    atFile.filtered.length,
    showAtFileSuggestions,
    visibleRows,
    suggestionsCap,
    atFileSuggestionsCap,
  ]);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {!showSlashSuggestions && !showAtFileSuggestions && currentScreen === 'home' && (
        <Box justifyContent="center">
          <Text color={theme.textDim}>/help /config /skills Ctrl+K</Text>
        </Box>
      )}
      {showSlashSuggestions && (
        <SlashSuggestions
          filtered={slash.filtered}
          selectedIndex={slash.selectedIndex}
          fuzzyMatch={slash.fuzzyMatch}
          maxVisible={suggestionsCap}
        />
      )}
      {showAtFileSuggestions && (
        <AtFileSuggestions
          filtered={atFile.filtered}
          selectedIndex={atFile.selectedIndex}
          maxVisible={atFileSuggestionsCap}
        />
      )}
      <AttachmentChips />
      <Box
        borderStyle="round"
        borderColor={borderColorForMode(mode, theme)}
        paddingX={1}
        width="100%"
        minHeight={3}
      >
        <Text color={theme.accent}>&gt; </Text>
        <Box flexGrow={1}>
          <MultilineInput
            key={`${slash.inputKey}:${inputEpoch}`}
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
              submit: (key: { return: boolean }) => key.return,
              newline: (key: { return: boolean; shift: boolean }) =>
                key.return && key.shift,
            }}
            onBoundaryNavigate={handleInputBoundaryNavigate}
          />
        </Box>
      </Box>
    </Box>
  );
}
