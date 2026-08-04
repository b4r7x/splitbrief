import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { FilterInput } from '../../components/filter-input.js';
import { useTheme } from '../../components/theme.js';
import { SOFT_SEP } from '../../components/separators.js';
import {
  OverlayPanel,
  computeOverlayInnerRowCapacity,
} from '../../components/overlays/overlay-panel.js';
import { ListGroupHeader, ListRow } from '../../components/list-row.js';
import { ScrollIndicator } from '../../components/scroll-indicator.js';
import { windowSlice } from '../../components/pickers/scroll-window.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from '../../components/pickers/row-zone.js';
import { dropLastGrapheme } from '../../components/input/text-editing.js';
import { buildPaletteResults } from '../../features/palette/results.js';
import type { PaletteResult, PaletteSource } from '../../features/palette/results.js';
import { buildPaletteSources } from '../../features/palette/sources.js';
import { commandPaletteMruStore } from '../../stores/ui/command-palette-mru.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import type {
  RuntimeCommandDef,
  RuntimeConfigSaveResult,
} from '../../core/runtime/commands/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { handleSessionSelect } from '../../stores/navigation/session-select.js';
import { sessionSelectDeps } from '../prepare-resume.js';

const PALETTE_MAX_WIDTH = 86;
const MAX_LABEL_WIDTH = 24;
const LABEL_COLUMN_GAP = 2;
const PROMPT_ROWS = 2;
const HINT_ROWS = 2;

const SOURCE_HEADERS: Record<PaletteSource, string> = {
  command: 'Commands',
  mode: 'Modes',
  picker: 'Pickers',
  task: 'Tasks',
  session: 'Sessions',
  custom: 'Actions',
};

function countSourceHeaders(items: PaletteResult[]): number {
  let headers = 0;
  let last: PaletteSource | null = null;
  for (const item of items) {
    if (item.source !== last) {
      headers += 1;
      last = item.source;
    }
  }
  return headers;
}

function fitPaletteWindow(
  results: PaletteResult[],
  cursor: number,
  listBudget: number,
): {
  scrollOffset: number;
  visible: PaletteResult[];
  showUp: boolean;
  showDown: boolean;
} {
  if (listBudget <= 0 || results.length === 0) {
    return { scrollOffset: 0, visible: [], showUp: false, showDown: false };
  }
  for (let size = Math.min(listBudget, results.length); size >= 1; size--) {
    const { scrollOffset, visibleSlice } = windowSlice({
      items: results,
      selectedIndex: cursor,
      windowSize: size,
    });
    const showUp = scrollOffset > 0;
    const showDown = scrollOffset + size < results.length;
    const listRows =
      visibleSlice.length +
      countSourceHeaders(visibleSlice) +
      (showUp ? 1 : 0) +
      (showDown ? 1 : 0);
    if (listRows <= listBudget) {
      return { scrollOffset, visible: visibleSlice, showUp, showDown };
    }
  }
  return { scrollOffset: 0, visible: [], showUp: false, showDown: false };
}

function isPaletteResultVisible(
  results: PaletteResult[],
  cursor: number,
  listBudget: number,
  index: number,
): boolean {
  const { scrollOffset, visible } = fitPaletteWindow(results, cursor, listBudget);
  return visible.some((_, i) => scrollOffset + i === index);
}

export interface CommandPaletteOverlayProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (raw: string) => unknown;
  onWorkflowMode: (mode: WorkflowMode) => Promise<RuntimeConfigSaveResult>;
}

export function CommandPaletteOverlay({
  commands,
  onRuntimeCommand,
  onWorkflowMode,
}: CommandPaletteOverlayProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const route = routerStore.use((s) => s);
  const screen = route.screen;
  const isAttached = route.screen === 'workflow' && route.execution.kind === 'attached';
  const config = configStore.useConfig();
  const phase = lifecycleStore.use((s) => s.phase);
  const mruIds = commandPaletteMruStore.use((s) => s.ids);
  const tasks = tasksStore.use((s) => s.tasks);
  const sessions = sessionsStore.use((s) => s.sessions);
  const projectDir = configStore.use((s) => s.projectDir);
  const rows = terminalSizeStore.use((s) => s.rows);

  useEffect(() => {
    sessionsStore.load(projectDir);
  }, [projectDir]);

  const sources = buildPaletteSources({
    commands,
    screen,
    config,
    phase,
    tasks,
    sessions,
    projectDir,
    onRuntimeCommand,
    onWorkflowMode,
    onSessionSelect: (session, dir) => handleSessionSelect(session, dir, sessionSelectDeps),
    isAttached,
  });

  const results = buildPaletteResults({
    query,
    mruIds,
    ...sources,
  });

  const listBudget = computeOverlayInnerRowCapacity({
    terminalRows: rows,
    outerChromeRows: PROMPT_ROWS + HINT_ROWS,
  });

  const runResult = async (index: number) => {
    const item = results[index];
    if (!item) return;
    if (!isPaletteResultVisible(results, cursor, listBudget, index)) return;
    if (item.source !== 'mode') {
      commandPaletteMruStore.record(item.id);
      overlayStore.close();
      try {
        await item.action();
      } catch (err) {
        feedbackStore.setError(toErrorMessage(err));
      }
      return;
    }
    try {
      const result = await item.action();
      if (result.kind === 'saved') {
        commandPaletteMruStore.record(item.id);
        overlayStore.close();
        return;
      }
      if (result.errorMessage) {
        feedbackStore.setError(result.errorMessage);
        return;
      }
      if (result.kind === 'conflict') {
        feedbackStore.setError('Config changed on disk. Reload before saving again.');
        return;
      }
      if (result.kind === 'durability-uncertain') {
        feedbackStore.setError('Config save could not be confirmed.');
        return;
      }
      feedbackStore.setError('Failed to save config.');
    } catch (err) {
      feedbackStore.setError(toErrorMessage(err));
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        overlayStore.close();
        return;
      }
      if (key.return) {
        void runResult(cursor);
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(results.length - 1, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => dropLastGrapheme(q));
        setCursor(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setCursor(0);
      }
    },
    { isActive: true },
  );

  const t = useTheme();
  const { scrollOffset, visible, showUp, showDown } = fitPaletteWindow(results, cursor, listBudget);
  const labelWidth =
    Math.min(
      MAX_LABEL_WIDTH,
      Math.max(0, ...visible.map((result) => getTerminalCellWidth(result.label))),
    ) + LABEL_COLUMN_GAP;
  const hasResults = visible.length > 0;
  const hint = hasResults
    ? ['↑↓ navigate', '⏎ select', 'esc close'].join(SOFT_SEP)
    : ['↑↓ navigate', 'esc close'].join(SOFT_SEP);

  const listNodes: ReactNode[] = [];
  let lastSource: PaletteSource | null = null;
  visible.forEach((result, i) => {
    if (result.source !== lastSource) {
      listNodes.push(
        <ListGroupHeader
          key={`header:${result.source}:${i}`}
          label={SOURCE_HEADERS[result.source]}
        />,
      );
      lastSource = result.source;
    }
    const globalIndex = scrollOffset + i;
    const isCursor = globalIndex === cursor;
    listNodes.push(
      <RowZone
        key={result.id}
        zoneId={`palette:${result.id}`}
        z={ROW_ZONE_Z_OVERLAY}
        onActivate={() => {
          void runResult(globalIndex);
        }}
      >
        <ListRow
          label={result.label}
          state={isCursor ? 'active' : 'default'}
          metadata={result.description}
          {...(result.shortcut ? { trailing: result.shortcut } : {})}
          labelWidth={labelWidth}
        />
      </RowZone>,
    );
  });

  return (
    <OverlayPanel hint={hint} maxWidth={PALETTE_MAX_WIDTH}>
      <Box marginBottom={1}>
        <FilterInput filter={query} />
      </Box>

      <Box flexDirection="column">
        {!hasResults && query.length > 0 && <Text color={t.textDim}>No matching commands</Text>}
        <ScrollIndicator show={showUp} direction="up" />
        {listNodes}
        <ScrollIndicator
          show={showDown}
          direction="down"
          count={results.length - scrollOffset - visible.length}
        />
      </Box>
    </OverlayPanel>
  );
}
