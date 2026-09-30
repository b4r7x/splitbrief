import type { Phase } from '../../../../core/schemas/enums.js';
import type { Screen } from '../../../../core/navigation/types.js';
import type {
  CommandGuardContext,
  RuntimeCommandDef,
} from '../../../../core/runtime/commands/types.js';
import {
  rankClosedOptions,
  suggestRuntimeCommand,
} from '../../../../core/runtime/commands/lookup.js';
import { detectedModelFact, seatSupportsImages } from '../../../../core/runners/capabilities.js';
import { configStore } from '../../../../stores/project/config.js';
import { modelCacheStore } from '../../../../stores/discovery/model-cache/state.js';
import { isOpenRunAtRest, routerStore } from '../../../../stores/navigation/router.js';
import { inputHistoryStore } from '../../../../stores/ui/input-history.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import type { CommandCompletionRow } from './menu.js';
import { useCompletionSelection } from '../use-completion-selection.js';
import { useCompletionNavigation } from '../use-completion-navigation.js';

interface UseCommandCompletionOptions {
  commands: RuntimeCommandDef[];
  currentScreen: Screen;
  value: string;
  setValue: (v: string) => void;
  onRuntimeCommand: (command: string) => void;
  disabled?: boolean | undefined;
  suppressed?: boolean | undefined;
}

interface UseCommandCompletionResult {
  filtered: CommandCompletionRow[];
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
  filtered: CommandCompletionRow[];
  fuzzyMatch: RuntimeCommandDef | null;
  argPrefix: string | null;
}

interface SelectionKeyInput {
  currentScreen: Screen;
  phase: Phase;
  query: string;
  filtered: CommandCompletionRow[];
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
  suppressed,
}: UseCommandCompletionOptions): UseCommandCompletionResult {
  const phase = lifecycleStore.use((s) => s.phase);
  const config = configStore.use((s) => s.config);
  const openRunAtRest = routerStore.use(isOpenRunAtRest);
  const guardContext: CommandGuardContext = {
    phase,
    plannerSupportsImages:
      config !== null &&
      seatSupportsImages({
        runner: config.planner,
        detected: detectedModelFact(modelCacheStore.getDetection().providers, config.planner),
      }),
    openRunAtRest,
  };

  const commandMode = value.startsWith('/');
  const whitespaceIndex = value.search(/\s/);
  const hasArgs = whitespaceIndex >= 0;
  const commandToken = hasArgs ? value.slice(0, whitespaceIndex) : value;
  const query = commandToken.toLowerCase();
  const argTail = hasArgs ? value.slice(whitespaceIndex + 1) : '';
  const validCommands = commands.filter((cmd) => {
    if (!cmd.validScreens.includes(currentScreen)) return false;
    if (cmd.guard?.(guardContext) !== undefined) return false;
    return true;
  });
  // Past the space the menu completes a token of a closed argument set. It closes for `free` args,
  // for `noarg` commands, and when no option matches the typed token, so it never swallows Enter
  // for a line the composer must submit raw to dispatch. A `multi` set keeps completing past the
  // second token: the last token is the query and everything before it is carried in the prefix.
  const argCommand = hasArgs
    ? validCommands.find((cmd) => cmd.name.toLowerCase() === query)
    : undefined;
  const argSpec =
    argCommand?.kind === 'arg' && argCommand.args.kind === 'closed' ? argCommand.args : null;
  const tailSplit = /^([\s\S]*\s)?(\S*)$/.exec(argTail);
  const argToken = argSpec?.multi === true ? (tailSplit?.[2] ?? '') : argTail;
  const argHead = argSpec?.multi === true ? (tailSplit?.[1] ?? '') : '';
  const closedArgs =
    argSpec !== null && (argSpec.multi === true || !/\s/.test(argTail)) ? argSpec : null;
  const argOptions =
    closedArgs !== null
      ? (closedArgs.match === 'fuzzy'
          ? rankClosedOptions(closedArgs.options, closedArgs.optionDescriptions, argToken)
          : closedArgs.options.filter((option) =>
              option.toLowerCase().startsWith(argToken.toLowerCase()),
            )
        ).map(
          (option): CommandCompletionRow => ({
            name: option,
            description: closedArgs.optionDescriptions?.[option] ?? '',
            trailing: closedArgs.optionHints?.[option] ?? null,
          }),
        )
      : null;
  const argRows = argOptions !== null && argOptions.length > 0 ? argOptions : null;
  const showSuggestions = commandMode && !suppressed && (!hasArgs || argRows !== null);
  const argPrefix = argRows === null ? null : `${commandToken} ${argHead}`;
  const matchQuery = argRows === null ? query : argToken.toLowerCase();
  const filtered = showSuggestions
    ? (argRows ??
      validCommands
        .filter((cmd) => cmd.name.toLowerCase().startsWith(query))
        .map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
          trailing: cmd.shortcut ?? null,
        })))
    : [];

  const fuzzyMatch =
    showSuggestions && argRows === null && filtered.length === 0
      ? suggestRuntimeCommand(validCommands, query)
      : null;
  const selectionKey = buildCommandSelectionKey({
    currentScreen,
    phase,
    query: matchQuery,
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
      argPrefix,
    });

  const { inputKey, bumpInputKey } = useCompletionNavigation({
    isActive: showSuggestions && !disabled,
    latestRef,
    hasItems: (l) => l.filtered.length > 0 || l.fuzzyMatch !== null,
    onMove: (l, dir) => moveSelection(l, dir),
    onTab: (l) => {
      const selected = l.filtered[l.effectiveSelectedIndex] ?? l.fuzzyMatch;
      if (!selected) return;
      setValue(`${l.argPrefix ?? ''}${selected.name}`);
      bumpInputKey();
    },
    onReturn: (l) => {
      // While the option menu is open Enter runs the highlighted row, as the menu's own footer
      // advertises. The bare `/cmd` invocation stays reachable by pressing Enter before the space.
      const selected = l.filtered[l.effectiveSelectedIndex];
      // A highlighted command runs; otherwise submit the raw slash line so the dispatcher decides
      // (unknown-command feedback, fuzzy suggestion) instead of silently running the fuzzy guess.
      const command = selected ? `${l.argPrefix ?? ''}${selected.name}` : l.value;
      inputHistoryStore.push(command);
      setValue('');
      onRuntimeCommand(command);
    },
    onSelect: () => {},
    onEscape: () => setValue(''),
  });

  return { filtered, fuzzyMatch, selectedIndex: effectiveSelectedIndex, showSuggestions, inputKey };
}
