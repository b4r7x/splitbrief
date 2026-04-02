import { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultilineInput } from 'ink-multiline-input';
import { SlashSuggestions } from './slash-suggestions.js';
import { useFilterableList } from '../hooks/use-filterable-list.js';
import { useAppContext } from '../app.js';
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
}: InputBarProps) {
  const { theme } = useAppContext();
  const [value, setValue] = useState('');

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

  const { selectedIndex } = useFilterableList({
    items: filtered,
    filterFn: passThroughFilter,
    onSelect,
    onClose,
    isActive: showSuggestions,
  });

  // Handle tab completion and backspace-on-empty-filter (not covered by hook)
  useInput(
    (_input, key) => {
      if (key.tab && filtered.length > 0) {
        const selected = filtered[selectedIndex];
        if (selected) {
          setValue(selected.name);
        }
      }
      if ((key.backspace || key.delete) && value === '/') {
        setValue('');
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
        {showSuggestions && (
          <Text>
            {value}
            <Text color={theme.textDim}>│</Text>
          </Text>
        )}
        <Box display={showSuggestions ? 'none' : 'flex'}>
          <MultilineInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            focus={!showSuggestions}
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
