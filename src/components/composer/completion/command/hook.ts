import type { Phase } from '../../../../core/schemas/enums.js';
import type { Screen } from '../../../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';
import { suggestRuntimeCommand } from '../../../../core/runtime/commands/lookup.js';
import { inputHistoryStore } from '../../../../stores/ui/input-history.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { useCompletionSelection } from '../use-completion-selection.js';
import { useCompletionNavigation } from '../use-completion-navigation.js';

function matchesCommandQuery(cmd: RuntimeCommandDef, query: string): boolean {
  if (cmd.name.toLowerCase().startsWith(query)) return true;
  return cmd.aliases?.some((a) => a.toLowerCase().startsWith(query)) ?? false;
}

interface UseCommandCompletionOptions {
  // Pre-filtered by createRuntimeCommands (e.g. attached clients expose ATTACHED_AVAILABLE_COMMANDS).
  commands: RuntimeCommandDef[];
  currentScreen: Screen;
  value: string;
  setValue: (v: string) => void;
  onRuntimeCommand: (command: string) => void;
  disabled?: boolean | undefined;
}

interface UseCommandCompletionResult {
  filtered: RuntimeCommandDef[];
  fuzzyMatch: RuntimeCommandDef | null;
  selectedIndex: number;
  showSuggestions: boolean;
  inputKey: number;
}

interface LatestCommandState {
  value: string;
  currentScreen: Screen;
  selectionKey: string;
  itemCount: number;
  filtered: RuntimeCommandDef[];
  fuzzyMatch: RuntimeCommandDef | null;
}

interface SelectionKeyInput {
  currentScreen: Screen;
  phase: Phase;
  query: string;
  filtered: RuntimeCommandDef[];
  fuzzyMatch: RuntimeCommandDef | null;
}

function buildCommandSelectionKey(input: SelectionKeyInput): string {
  const { currentScreen, phase, query, filtered, fuzzyMatch } = input;
  return [
    currentScreen,
    phase,
    query,
    filtered.map((cmd) => cmd.name).join('\u0000'),
    fuzzyMatch?.name ?? '',
  ].join('\u0001');
}

export function useCommandCompletion({
  commands,
  currentScreen,
  value,
  setValue,
  onRuntimeCommand,
  disabled,
}: UseCommandCompletionOptions): UseCommandCompletionResult {
  const phase = lifecycleStore.use((s) => s.phase);

  const commandMode = value.startsWith('/');
  const whitespaceIndex = value.search(/\s/);
  const hasArgs = whitespaceIndex >= 0;
  const commandToken = hasArgs ? value.slice(0, whitespaceIndex) : value;
  const query = commandToken.toLowerCase();
  const validCommands = commands.filter((cmd) => {
    if (!cmd.validScreens.includes(currentScreen)) return false;
    if (cmd.phaseGuard && !cmd.phaseGuard(phase)) return false;
    return true;
  });
  // Suggestions match the command token only and close once arguments begin, so the menu never
  // swallows Enter for an argument'd command — the composer submits the raw line to dispatch instead.
  const showSuggestions = commandMode && !hasArgs;
  const filtered = showSuggestions
    ? validCommands.filter((cmd) => matchesCommandQuery(cmd, query))
    : [];

  const fuzzyMatch =
    showSuggestions && filtered.length === 0 ? suggestRuntimeCommand(validCommands, query) : null;
  const selectionKey = buildCommandSelectionKey({
    currentScreen,
    phase,
    query,
    filtered,
    fuzzyMatch,
  });
  const { effectiveSelectedIndex, latestRef, moveSelection } =
    useCompletionSelection<LatestCommandState>({
      value,
      currentScreen,
      selectionKey,
      itemCount: filtered.length,
      filtered,
      fuzzyMatch,
    });

  const { inputKey, bumpInputKey } = useCompletionNavigation({
    isActive: showSuggestions && !disabled,
    latestRef,
    hasItems: (l) => l.filtered.length > 0 || l.fuzzyMatch !== null,
    onMove: (l, dir) => moveSelection(l, dir),
    onTab: (l) => {
      const selected = l.filtered[l.effectiveSelectedIndex];
      if (selected) {
        setValue(selected.name);
        bumpInputKey();
      } else if (l.fuzzyMatch) {
        setValue(l.fuzzyMatch.name);
        bumpInputKey();
      }
    },
    onReturn: (l) => {
      const selected = l.filtered[l.effectiveSelectedIndex];
      // A highlighted command runs; otherwise submit the raw slash line so the dispatcher decides
      // (unknown-command feedback, fuzzy suggestion) instead of silently running the fuzzy guess.
      const command = selected ? selected.name : l.value;
      inputHistoryStore.push(command);
      onRuntimeCommand(command);
      setValue('');
    },
    onSelect: () => {},
    onEscape: () => setValue(''),
  });

  return { filtered, fuzzyMatch, selectedIndex: effectiveSelectedIndex, showSuggestions, inputKey };
}
