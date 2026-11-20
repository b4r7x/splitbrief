import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { FilterInput } from '../../components/filter-input.js';
import { CLOSE_HINT, formatKeyHints, SELECT_HINT } from '../../components/key-legend.js';
import { OverlayPanel } from '../../components/overlays/panel.js';
import { ListRows, planViewportRows } from '../../components/list-row/rows.js';
import { isItemIndexVisible } from '../../components/pickers/scroll-window.js';
import { dropLastGrapheme } from '../../components/input/text-editing.js';
import { buildPaletteResults } from '../../features/palette/results.js';
import type {
  CategorizedPaletteSource,
  PaletteResult,
  PaletteSource,
} from '../../features/palette/results.js';
import { buildPaletteSources } from '../../features/palette/sources.js';
import { commandPaletteMruStore } from '../../stores/ui/command-palette-mru.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { COMMAND_CATEGORY_LABELS } from '../../core/runtime/commands/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import {
  overlayInnerRowCapacity,
  overlayRect,
  type OverlayDensity,
} from '../../core/navigation/overlay-rect.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { handleSessionSelect } from '../../stores/navigation/session-select.js';
import { navigateIndex } from '../../utils/indexing.js';
import { sessionSelectDeps } from '../prepare-resume.js';

const PANEL_DENSITY: OverlayDensity = 'roomy';
const PROMPT_ROWS = 2;
const HINT_ROWS = 2;
// Below this budget a header costs more rows than it organises, so the 60x18 palette
// keeps the category order but drops the labels (§Target frames, palette-60x18).
const SECTION_HEADER_MIN_ROWS = 12;
// Command rows carry a category and are sectioned by it; every other source, skills included, is
// sectioned by its own name.
const SOURCE_HEADERS: Record<Exclude<PaletteSource, CategorizedPaletteSource>, string> = {
  task: 'Tasks',
  session: 'Sessions',
  custom: 'Actions',
  skill: 'Skills',
};

function sectionLabel(result: PaletteResult): string {
  return result.category === null
    ? SOURCE_HEADERS[result.source]
    : COMMAND_CATEGORY_LABELS[result.category];
}

export interface CommandPaletteOverlayProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (raw: string) => unknown;
}

export function CommandPaletteOverlay({ commands, onRuntimeCommand }: CommandPaletteOverlayProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const route = routerStore.use((s) => s);
  const screen = route.screen;
  const config = configStore.useConfig();
  const phase = runViewStore.use((s) => s.phase);
  const mruIds = commandPaletteMruStore.use((s) => s.ids);
  const tasks = runViewStore.use((s) => s.briefs.tasks);
  const sessions = sessionsStore.use((s) => s.sessions);
  // The palette lists runs too, read again whenever it opens.
  useEffect(() => {
    sessionsStore.refresh();
  }, []);
  const projectDir = configStore.use((s) => s.projectDir);
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);

  const sources = buildPaletteSources({
    commands,
    screen,
    config,
    phase,
    tasks,
    sessions,
    projectDir,
    onRuntimeCommand,
    onSessionSelect: (session, dir) => handleSessionSelect(session, dir, sessionSelectDeps),
  });

  const results = buildPaletteResults({
    query,
    mruIds,
    ...sources,
  });

  const listBudget = overlayInnerRowCapacity({
    rows,
    outerChromeRows: PROMPT_ROWS + HINT_ROWS,
  });
  const { innerWidth } = overlayRect({ cols, rows, density: PANEL_DENSITY });
  const models = results.map((result) => ({
    section: sectionLabel(result),
    name: result.label,
    description: result.source === 'task' || result.source === 'session' ? '' : result.description,
    hint: result.hint,
    trailing: result.source === 'task' || result.source === 'session' ? result.description : null,
    badge: result.shortcut,
    group: result.source,
  }));
  const section =
    listBudget >= SECTION_HEADER_MIN_ROWS
      ? (index: number) => models[index]?.section ?? ''
      : undefined;
  const lines = planViewportRows(models, innerWidth, listBudget, section);
  const canActOnIndex = (index: number) =>
    isItemIndexVisible<(typeof lines)[number]>({
      items: lines,
      selectedIndex: lines.findIndex((line) => line.row === cursor),
      itemIndex: lines.findIndex((line) => line.row === index),
      rowBudget: listBudget,
      section: section && { by: (line) => section(line.row) },
    });

  const runResult = async (index: number) => {
    const item = results[index];
    if (!item) return;
    if (!canActOnIndex(index)) return;
    commandPaletteMruStore.record(item.id);
    overlayStore.close();
    if (item.action.kind === 'prefill') {
      composerDraftStore.requestCommand(item.action.text);
      return;
    }
    try {
      await item.action.run();
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
        setCursor((c) => navigateIndex('up', c, results.length));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => navigateIndex('down', c, results.length));
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
  const hint = canActOnIndex(cursor)
    ? formatKeyHints([SELECT_HINT, { key: '⏎', verb: 'run or fill in' }, CLOSE_HINT])
    : formatKeyHints([SELECT_HINT, CLOSE_HINT]);

  return (
    <OverlayPanel hint={hint} density={PANEL_DENSITY}>
      <Box marginBottom={1}>
        <FilterInput filter={query} placeholder="Type a command…" />
      </Box>

      <ListRows
        lines={lines}
        selectedIndex={cursor}
        focused
        getKey={(i) => results[i]?.id ?? ''}
        rowBudget={listBudget}
        width={innerWidth}
        section={section}
        rowZonePrefix="palette"
        showRemainingCount
        onActivate={(index) => {
          void runResult(index);
        }}
        placeholder={<Text color={t.textDim}>No matching commands</Text>}
      />
    </OverlayPanel>
  );
}
