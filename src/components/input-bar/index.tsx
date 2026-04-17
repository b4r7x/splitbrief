import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from '../input/multiline-input.js';
import { SlashSuggestions } from './slash-suggestions.js';
import { useSlashAutocomplete } from './use-slash-autocomplete.js';
import { useTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { useStores } from '../../stores/use-stores.js';
import type { InputMode, Screen, SlashCommandDef } from '../../types.js';
import { useInputBarHistory } from './use-input-bar-history.js';

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
  const [{ cols }] = useStores(terminalSizeStore);
  const inputColumns = Math.max(1, (width ?? cols) - 6);
  const [value, setValue] = useState('');
  const [visibleRows, setVisibleRows] = useState(1);

  const { inputEpoch, bumpEpoch, handleBoundaryNavigate, resetHistory, onChange } = useInputBarHistory({
    currentScreen,
    disabled,
    value,
    setValue,
  });

  const { filtered, fuzzyMatch, selectedIndex, showSuggestions, inputKey } = useSlashAutocomplete({
    commands,
    currentScreen,
    value,
    setValue: onChange,
    onSlashCommand,
    disabled,
  });

  const handleSubmit = (text: string) => {
    if (showSuggestions) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (currentScreen === 'home') {
      inputHistoryStore.push(trimmed);
    }

    if (trimmed.startsWith('/')) {
      onSlashCommand(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setValue('');
    resetHistory();
    bumpEpoch();
  };

  useEffect(() => {
    const suggestionRows = showSuggestions ? Math.min(filtered.length, 8) : 0;
    inputHeightStore.setRows(visibleRows + 2 + suggestionRows);
  }, [filtered.length, showSuggestions, visibleRows]);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {!showSuggestions && currentScreen === 'home' && (
        <Box justifyContent="center">
          <Text color={theme.textDim}>/help /config /skills Ctrl+K</Text>
        </Box>
      )}
      {showSuggestions && (
        <SlashSuggestions
          filtered={filtered}
          selectedIndex={selectedIndex}
          fuzzyMatch={fuzzyMatch}
        />
      )}
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
            key={`${inputKey}:${inputEpoch}`}
            value={value}
            onChange={onChange}
            onSubmit={handleSubmit}
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
            onBoundaryNavigate={handleBoundaryNavigate}
          />
        </Box>
      </Box>
    </Box>
  );
}
