import { useRef, useState } from 'react';
import { useInput } from 'ink';
import type { Screen } from '../../stores/navigation/router.js';
import type { SlashCommandDef } from '../../core/slash-commands/types.js';
import { fuzzyMatchCommand } from '../../core/slash-commands/fuzzy.js';
import { rotateIndex } from '../pickers/picker-utils.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';

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
  fuzzyMatch: SlashCommandDef | null;
  selectedIndex: number;
  showSuggestions: boolean;
  inputKey: number;
}

interface SelectionState {
  key: string;
  index: number;
}

interface LatestSlashState {
  currentScreen: Screen;
  selectionKey: string;
  filtered: SlashCommandDef[];
  fuzzyMatch: SlashCommandDef | null;
  effectiveSelectedIndex: number;
}

function buildSelectionKey(
  currentScreen: Screen,
  phase: string,
  query: string,
  filtered: SlashCommandDef[],
  fuzzyMatch: SlashCommandDef | null,
): string {
  return [
    currentScreen,
    phase,
    query,
    filtered.map(cmd => cmd.name).join('\u0000'),
    fuzzyMatch?.name ?? '',
  ].join('\u0001');
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
  const [selection, setSelection] = useState<SelectionState>({ key: '', index: 0 });
  const latestRef = useRef<LatestSlashState | null>(null);
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
  const selectionKey = buildSelectionKey(currentScreen, phase, query, filtered, fuzzyMatch);
  const selectedIndex = selection.key === selectionKey ? selection.index : 0;
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
  latestRef.current = {
    currentScreen,
    selectionKey,
    filtered,
    fuzzyMatch,
    effectiveSelectedIndex,
  };

  useInput(
    (_input, key) => {
      const latest = latestRef.current;
      if (!latest) return;

      if (key.escape) {
        setValue('');
        return;
      }
      if (key.upArrow) {
        if (latest.filtered.length > 0) {
          setSelection({
            key: latest.selectionKey,
            index: rotateIndex(latest.effectiveSelectedIndex, latest.filtered.length, -1),
          });
        }
        return;
      }
      if (key.downArrow) {
        if (latest.filtered.length > 0) {
          setSelection({
            key: latest.selectionKey,
            index: rotateIndex(latest.effectiveSelectedIndex, latest.filtered.length, 1),
          });
        }
        return;
      }
      if (key.tab) {
        const selected = latest.filtered[latest.effectiveSelectedIndex];
        if (selected) {
          setValue(selected.name);
          setInputKey((k) => k + 1);
        } else if (latest.fuzzyMatch) {
          setValue(latest.fuzzyMatch.name);
          setInputKey((k) => k + 1);
        }
        return;
      }
      if (key.return) {
        const selected = latest.filtered[latest.effectiveSelectedIndex];
        const command = selected?.name ?? latest.fuzzyMatch?.name;
        if (command) {
          if (latest.currentScreen === 'home') {
            inputHistoryStore.push(command);
          }
          onSlashCommand(command);
          setValue('');
        }
        return;
      }
    },
    { isActive: showSuggestions && !disabled },
  );

  return { filtered, fuzzyMatch, selectedIndex: effectiveSelectedIndex, showSuggestions, inputKey };
}
