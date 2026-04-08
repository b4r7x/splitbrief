import { useState } from 'react';
import { useInput } from 'ink';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import type { Screen, SlashCommandDef } from '../../types.js';

const ALLOW_ALL_CHARS = () => true;
const BLOCK_ALL_CHARS = () => false;

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
  disabled?: boolean;
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

  const slashMode = value.startsWith('/');
  const screenCmds = commands.filter((cmd) => cmd.validScreens.includes(currentScreen));

  const onSelect = (cmd: SlashCommandDef) => {
    onSlashCommand(cmd.name);
    setValue('');
  };

  const onClose = () => setValue('');

  const query = '/' + value.slice(1).toLowerCase();
  const filtered = slashMode
    ? screenCmds.filter(cmd => matchesSlashQuery(cmd, query))
    : [];

  const showSuggestions = slashMode && filtered.length > 0;

  const { selectedIndex } = useFilterableList({
    items: filtered,
    filterFn: ALLOW_ALL_CHARS,
    onSelect,
    onClose,
    isActive: showSuggestions && !disabled,
    shouldAppendChar: BLOCK_ALL_CHARS,
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
    { isActive: showSuggestions && !disabled },
  );

  return { filtered, selectedIndex, showSuggestions, inputKey };
}
