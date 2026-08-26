import type { Phase } from '../../../../core/schemas/enums.js';
import type { Screen } from '../../../../core/navigation/types.js';
import type {
  CommandGuardContext,
  RuntimeCommandDef,
} from '../../../../core/runtime/commands/types.js';
import { suggestRuntimeCommand } from '../../../../core/runtime/commands/lookup.js';
import { detectedModelFact, seatSupportsImages } from '../../../../core/runners/capabilities.js';
import { configStore } from '../../../../stores/project/config.js';
import { modelCacheStore } from '../../../../stores/discovery/model-cache.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import { inputHistoryStore } from '../../../../stores/ui/input-history.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { useCompletionSelection } from '../use-completion-selection.js';
import { useCompletionNavigation } from '../use-completion-navigation.js';

function matchingRows(cmd: RuntimeCommandDef, query: string): RuntimeCommandDef[] {
  const rows: RuntimeCommandDef[] = [];
  if (cmd.name.toLowerCase().startsWith(query)) rows.push(cmd);
  for (const alias of cmd.aliases ?? []) {
    if (!alias.name.toLowerCase().startsWith(query)) continue;
    rows.push({
      ...cmd,
      name: alias.name,
      description: `Alias for ${cmd.name}${alias.args ? ` ${alias.args}` : ''}`,
    });
  }
  return rows;
}

// Argument rows are display-only: the hook submits the command token plus the row name, so the
// synthesized handler is never reached.
function argumentRow(cmd: RuntimeCommandDef, option: string): RuntimeCommandDef {
  return {
    kind: 'noarg',
    name: option,
    description: '',
    category: cmd.category,
    validScreens: cmd.validScreens,
    handler: () => {},
  };
}

interface UseCommandCompletionOptions {
  // Pre-filtered by createRuntimeCommands (e.g. attached clients expose ATTACHED_AVAILABLE_COMMANDS).
  commands: RuntimeCommandDef[];
  currentScreen: Screen;
  value: string;
  setValue: (v: string) => void;
  onRuntimeCommand: (command: string) => void;
  disabled?: boolean | undefined;
  suppressed?: boolean | undefined;
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
  argPrefix: string | null;
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
  suppressed,
}: UseCommandCompletionOptions): UseCommandCompletionResult {
  const phase = lifecycleStore.use((s) => s.phase);
  const config = configStore.use((s) => s.config);
  const attached = routerStore.use(
    (route) => route.screen === 'workflow' && route.execution.kind === 'attached',
  );
  const guardContext: CommandGuardContext = {
    phase,
    attached,
    plannerSupportsImages:
      config !== null &&
      seatSupportsImages({
        runner: config.planner,
        detected: detectedModelFact(modelCacheStore.getDetection().providers, config.planner),
      }),
  };

  const commandMode = value.startsWith('/');
  const whitespaceIndex = value.search(/\s/);
  const hasArgs = whitespaceIndex >= 0;
  const commandToken = hasArgs ? value.slice(0, whitespaceIndex) : value;
  const query = commandToken.toLowerCase();
  const argToken = hasArgs ? value.slice(whitespaceIndex + 1) : '';
  const validCommands = commands.filter((cmd) => {
    if (!cmd.validScreens.includes(currentScreen)) return false;
    if (cmd.guard?.(guardContext) !== undefined) return false;
    return true;
  });
  // Past the space the menu completes the second token of a closed argument set. It closes for
  // `free` args, for `noarg` commands, and when no option matches the typed prefix, so it never
  // swallows Enter for a line the composer must submit raw to dispatch.
  // An alias with `args` carries a pre-filled argument that dispatch prepends to whatever follows,
  // so only the command name and no-arg aliases open the option menu.
  const argCommand =
    hasArgs && !/\s/.test(argToken)
      ? validCommands.find(
          (cmd) =>
            cmd.name.toLowerCase() === query ||
            (cmd.aliases ?? []).some(
              (alias) => alias.name.toLowerCase() === query && alias.args === undefined,
            ),
        )
      : undefined;
  const closedArgs =
    argCommand?.kind === 'arg' && argCommand.args.kind === 'closed' ? argCommand.args : null;
  const argOptions =
    argCommand !== undefined && closedArgs !== null
      ? closedArgs.options
          .filter((option) => option.toLowerCase().startsWith(argToken.toLowerCase()))
          .map((option) => argumentRow(argCommand, option))
      : null;
  const argRows = argOptions !== null && argOptions.length > 0 ? argOptions : null;
  const showSuggestions = commandMode && !suppressed && (!hasArgs || argRows !== null);
  const argPrefix = argRows === null ? null : `${commandToken} `;
  const matchQuery = argRows === null ? query : argToken.toLowerCase();
  const filtered = showSuggestions
    ? (argRows ?? validCommands.flatMap((cmd) => matchingRows(cmd, query)))
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
      onRuntimeCommand(command);
      setValue('');
    },
    onSelect: () => {},
    onEscape: () => setValue(''),
  });

  return { filtered, fuzzyMatch, selectedIndex: effectiveSelectedIndex, showSuggestions, inputKey };
}
