import { useState } from 'react';
import { useInput } from 'ink';
import { Fzf } from 'fzf';
import type { Screen, SlashCommandDef } from '../../types.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';

function matchesSlashQuery(cmd: SlashCommandDef, query: string): boolean {
  if (cmd.name.toLowerCase().startsWith(query)) return true;
  return cmd.aliases?.some(a => a.toLowerCase().startsWith(query)) ?? false;
}

function rotateIndex(current: number, length: number, delta: 1 | -1): number {
  return (current + delta + length) % length;
}

function fuzzyMatchCommand(commands: SlashCommandDef[], query: string): SlashCommandDef | null {
  const bare = query.startsWith('/') ? query.slice(1) : query;
  if (!bare) return null;
  const fzf = new Fzf(commands, { selector: (c: SlashCommandDef) => c.name.slice(1) });
  const results = fzf.find(bare);
  const top = results[0];
  return top !== undefined && top.score > 0 ? top.item : null;
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
  fuzzyMatch: SlashCommandDef | null;
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
  const phase = lifecycleStore.use(s => s.phase);

  const slashMode = value.startsWith('/');
  const query = '/' + value.slice(1).toLowerCase();
  const validCommands = commands.filter((cmd) => {
    if (!cmd.validScreens.includes(currentScreen)) return false;
    if (cmd.phaseGuard && !cmd.phaseGuard(phase)) return false;
    return true;
  });
  const filtered = slashMode
    ? validCommands.filter((cmd) => matchesSlashQuery(cmd, query))
    : [];

  const fuzzyMatch = slashMode && filtered.length === 0
    ? fuzzyMatchCommand(validCommands, query)
    : null;

  const showSuggestions = slashMode && (filtered.length > 0 || fuzzyMatch !== null);
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useInput(
    (_input, key) => {
      if (key.return) {
        const selected = filtered[effectiveSelectedIndex];
        if (selected) {
          if (currentScreen === 'home') {
            inputHistoryStore.push(selected.name);
          }
          onSlashCommand(selected.name);
          setValue('');
        } else if (fuzzyMatch) {
          if (currentScreen === 'home') {
            inputHistoryStore.push(fuzzyMatch.name);
          }
          onSlashCommand(fuzzyMatch.name);
          setValue('');
        }
        return;
      }
      if (key.escape) {
        setValue('');
        return;
      }
      if (key.tab && !key.shift) {
        if (filtered.length > 0) {
          setSelectedIndex((i) => rotateIndex(Math.min(i, Math.max(0, filtered.length - 1)), filtered.length, 1));
        } else if (fuzzyMatch) {
          setValue(fuzzyMatch.name);
          setInputKey((k) => k + 1);
        }
        return;
      }
      if (key.tab && key.shift) {
        if (filtered.length > 0) {
          setSelectedIndex((i) => rotateIndex(Math.min(i, Math.max(0, filtered.length - 1)), filtered.length, -1));
        }
        return;
      }
    },
    { isActive: showSuggestions && !disabled },
  );

  return { filtered, fuzzyMatch, selectedIndex: effectiveSelectedIndex, showSuggestions, inputKey };
}
