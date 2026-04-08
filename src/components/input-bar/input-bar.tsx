import { useState } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from '../../ui/input/multiline-input.js';
import { SlashSuggestions } from './slash-suggestions.js';
import { useSlashAutocomplete } from './use-slash-autocomplete.js';
import { useTheme } from '../../ui/theme.js';
import { useResponsiveLayout } from '../../hooks/use-terminal-size.js';
import { feedbackStore } from '../../stores/feedback.js';
import type { InputMode, Screen, SlashCommandDef } from '../../types.js';

function borderColorForMode(mode: InputMode, theme: { planner: string; warning: string; border: string }): string {
  if (mode === 'review') return theme.planner;
  if (mode === 'question') return theme.warning;
  return theme.border;
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
  const feedbackMessage = feedbackStore.use(s => s.message);
  const feedbackIsError = feedbackStore.use(s => s.isError);
  const theme = useTheme();
  const { cols } = useResponsiveLayout();
  const inputColumns = (width ?? cols) - 6;
  const [value, setValue] = useState('');

  const { filtered, selectedIndex, showSuggestions, inputKey } = useSlashAutocomplete({
    commands,
    currentScreen,
    value,
    setValue,
    onSlashCommand,
    disabled,
  });

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
          <Text color={theme.textDim}>/help /config /skills Ctrl+K</Text>
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
        borderColor={borderColorForMode(mode, theme)}
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
            focus={!disabled}
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
      {feedbackMessage && (
        <Box paddingX={2}>
          <Text color={feedbackIsError ? theme.error : theme.info}>{feedbackMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
