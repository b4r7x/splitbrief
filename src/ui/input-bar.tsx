import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text } from 'ink';
import { MultilineInput } from 'ink-multiline-input';
import type { InputMode, Screen } from '../types.js';
import type { Theme } from '../theme.js';

interface InputBarProps {
  onSubmit: (text: string) => void;
  onSlashCommand?: (command: string) => void;
  errorMessage?: string | null;
  onClearError?: () => void;
  mode: InputMode;
  hint: string;
  currentScreen: Screen;
  theme: Theme;
}

export function InputBar({ onSubmit, onSlashCommand, errorMessage, onClearError, mode, hint, currentScreen, theme }: InputBarProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!errorMessage || !onClearError) return;
    const timer = setTimeout(onClearError, 3000);
    return () => clearTimeout(timer);
  }, [errorMessage, onClearError]);

  const handleSubmit = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/') && onSlashCommand) {
      onSlashCommand(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setValue('');
  }, [onSubmit, onSlashCommand]);

  const placeholder = hint || (mode === 'review'
    ? 'approve / edit / comment ... / quit'
    : mode === 'question'
      ? 'type your answer...'
      : 'describe your feature...');

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} width="100%">
        <Text color={theme.accent}>&gt; </Text>
        <MultilineInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          rows={1}
          maxRows={6}
          keyBindings={{
            submit: (key: { return: boolean }) => key.return,
            newline: (key: { return: boolean; shift: boolean }) => key.return && key.shift,
          }}
        />
      </Box>
      {errorMessage && (
        <Box paddingX={2}>
          <Text color={theme.error}>{errorMessage}</Text>
        </Box>
      )}
      {currentScreen === 'home' && (
        <Box justifyContent="center">
          <Text color={theme.textDim}>/help  /status  /init  Ctrl+K palette</Text>
        </Box>
      )}
    </Box>
  );
}
