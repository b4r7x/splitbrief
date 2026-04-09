import { useState } from 'react';
import { useInput } from 'ink';
import type { Screen, SlashCommandDef } from '../../types.js';

function matchesSlashQuery(cmd: SlashCommandDef, query: string): boolean {
  if (cmd.name.toLowerCase().startsWith(query)) return true;
  return cmd.aliases?.some(a => a.toLowerCase().startsWith(query)) ?? false;
}

interface UseSlashAutocompleteOptions {
  commands: SlashCommandDef[];
  currentScreen: Screen;
  value: string;
  setValue: (v: string) => void;
  onSlashCommand: (command: string) => void;
  disabled?: boolean | undefined;
}

interface UseSlashAutocompleteResult {
  filtered: SlashCommandDef[];
  selectedIndex: number;
  showSuggestions: boolean;
  inputKey: number;
}

export function useSlashAutocomplete({
  commands,
  currentScreen,
  value,
  setValue,
  onSlashCommand,
  disabled,
}: UseSlashAutocompleteOptions): UseSlashAutocompleteResult {
  const [inputKey, setInputKey] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const slashMode = value.startsWith('/');
  const query = '/' + value.slice(1).toLowerCase();
  const filtered = slashMode
    ? commands.filter((cmd) => cmd.validScreens.includes(currentScreen) && matchesSlashQuery(cmd, query))
    : [];

  const showSuggestions = slashMode && filtered.length > 0;
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setSelectedIndex((i) => {
          const clamped = Math.min(i, Math.max(0, filtered.length - 1));
          return (clamped - 1 + filtered.length) % filtered.length;
        });
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => {
          const clamped = Math.min(i, Math.max(0, filtered.length - 1));
          return (clamped + 1) % filtered.length;
        });
        return;
      }
      if (key.return) {
        const selected = filtered[effectiveSelectedIndex];
        if (selected) {
          onSlashCommand(selected.name);
          setValue('');
        }
        return;
      }
      if (key.escape) {
        setValue('');
        return;
      }
      if (key.tab) {
        const selected = filtered[effectiveSelectedIndex];
        if (selected) {
          setValue(selected.name);
          setInputKey((k) => k + 1);
        }
      }
    },
    { isActive: showSuggestions && !disabled },
  );

  return { filtered, selectedIndex: effectiveSelectedIndex, showSuggestions, inputKey };
}
