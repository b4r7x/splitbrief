import { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultilineInput } from '../ui/multiline-input.js';
import { SlashSuggestions } from './slash-suggestions.js';
import { useFilterableList } from '../hooks/use-filterable-list.js';
import { useTheme } from '../ui/theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import type { InputMode, Screen, SlashCommandDef } from '../types.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onSlashCommand: (command: string) => void;
  commands: SlashCommandDef[];
  errorMessage?: string | null;
  onClearError?: () => void;
  mode: InputMode;
  hint: string;
  currentScreen: Screen;
  width?: number;
}

export function InputBar({
  onSubmit,
  onSlashCommand,
  commands,
  errorMessage,
  onClearError,
  mode,
  hint,
  currentScreen,
  width,
}: InputBarProps) {
  const theme = useTheme();
  const { cols } = useResponsiveLayout();
  const inputColumns = (width ?? cols) - 6; // border(2) + paddingX(2) + "> " prefix(2)
  const [value, setValue] = useState('');
  const [inputKey, setInputKey] = useState(0);

  const slashMode = value.startsWith('/');
  const screenCmds = useMemo(
    () => commands.filter((cmd) => cmd.validScreens.includes(currentScreen)),
    [commands, currentScreen],
  );

  const onSelect = (cmd: SlashCommandDef) => {
    onSlashCommand(cmd.name);
    setValue('');
  };

  const onClose = () => setValue('');

  const filtered = useMemo(
    () =>
      slashMode
        ? screenCmds.filter((cmd) =>
            cmd.name.toLowerCase().startsWith('/' + value.slice(1).toLowerCase()),
          )
        : [],
    [slashMode, value, screenCmds],
  );

  const showSuggestions = slashMode && filtered.length > 0;

  const passThroughFilter = useCallback(() => true, []);
  const blockAppend = useCallback(() => false, []);

  const { selectedIndex } = useFilterableList({
    items: filtered,
    filterFn: passThroughFilter,
    onSelect,
    onClose,
    isActive: showSuggestions,
    shouldAppendChar: blockAppend,
  });

  useInput(
    (_input, key) => {
      if (key.tab && filtered.length > 0) {
        const selected = filtered[selectedIndex];
        if (selected) {
          setValue(selected.name);
          setInputKey((k) => k + 1);
        }
      }
    },
    { isActive: showSuggestions },
  );

  useEffect(() => {
    if (!errorMessage || !onClearError) return;
    const timer = setTimeout(onClearError, 3000);
    return () => clearTimeout(timer);
  }, [errorMessage, onClearError]);

  const handleSubmit = (text: string) => {
    if (showSuggestions) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      onSlashCommand(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setValue('');
  };

  return (
    <Box flexDirection="column" width="100%">
      {!showSuggestions && currentScreen === 'home' && (
        <Box justifyContent="center">
          <Text color={theme.textDim}>/help /status /init Ctrl+K palette</Text>
        </Box>
      )}
      {showSuggestions && (
        <SlashSuggestions
          filtered={filtered}
          selectedIndex={selectedIndex}
        />
      )}
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={1}
        width="100%"
      >
        <Text color={theme.accent}>&gt; </Text>
        <Box flexGrow={1}>
          <MultilineInput
            key={inputKey}
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            columns={inputColumns}
            focus
            placeholder={
              hint ||
              (mode === 'review'
                ? 'approve / edit / comment ... / quit'
                : mode === 'question'
                  ? 'type your answer...'
                  : 'describe your feature...')
            }
            rows={1}
            maxRows={6}
            keyBindings={{
              submit: (key: { return: boolean }) => key.return,
              newline: (key: { return: boolean; shift: boolean }) =>
                key.return && key.shift,
            }}
          />
        </Box>
      </Box>
      {errorMessage && (
        <Box paddingX={2}>
          <Text color={theme.error}>{errorMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
