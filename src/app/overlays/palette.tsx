import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { FilterInput } from '../../components/filter-input.js';
import { useTheme } from '../../components/theme.js';
import { SOFT_SEP } from '../../components/separators.js';
import { OverlayPanel, overlayInnerRowCapacity } from '../../components/overlays/overlay-panel.js';
import { ListRow } from '../../components/list-row.js';
import { commandLabelWidth, descriptionColumn } from '../../components/list-columns.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import { isItemIndexVisible } from '../../components/pickers/scroll-window.js';
import { dropLastGrapheme } from '../../components/input/text-editing.js';
import { buildPaletteResults } from '../../features/palette/results.js';
import type { PaletteResult, PaletteSource } from '../../features/palette/results.js';
import { buildPaletteSources } from '../../features/palette/sources.js';
import { commandPaletteMruStore } from '../../stores/ui/command-palette-mru.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { COMMAND_CATEGORY_LABELS } from '../../core/runtime/commands/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { overlayRect, type OverlayDensity } from '../../core/navigation/overlay-rect.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { handleSessionSelect } from '../../stores/navigation/session-select.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { sessionSelectDeps } from '../prepare-resume.js';

const PANEL_DENSITY: OverlayDensity = 'roomy';
const PROMPT_ROWS = 2;
const HINT_ROWS = 2;
// Below this budget a header costs more rows than it organises, so the 60x18 palette
// keeps the category order but drops the labels (§Target frames, palette-60x18).
const SECTION_HEADER_MIN_ROWS = 12;
// A pathological command name must not swallow the row: past half the panel the label column is
// truncated instead, so the description column always survives (exercised by the row-truncation
// test at 50 columns).
const LABEL_COLUMN_SHARE = 0.5;
// Cells a widened label leaves behind for the status word a session or task row carries.
const STATUS_RESERVE = 14;

// Command rows always carry a category and are sectioned by it, so they never reach this map.
const SOURCE_HEADERS: Record<Exclude<PaletteSource, 'command'>, string> = {
  task: 'Tasks',
  session: 'Sessions',
  custom: 'Actions',
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
  const phase = lifecycleStore.use((s) => s.phase);
  const mruIds = commandPaletteMruStore.use((s) => s.ids);
  const tasks = tasksStore.use((s) => s.tasks);
  const sessions = sessionsStore.use((s) => s.sessions);
  const projectDir = configStore.use((s) => s.projectDir);
  const cols = terminalSizeStore.use((s) => s.cols);
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
  const section = {
    by: sectionLabel,
    headerFor: () => listBudget >= SECTION_HEADER_MIN_ROWS,
  };
  const canActOnIndex = (index: number) =>
    isItemIndexVisible({ items: results, selectedIndex: index, rowBudget: listBudget, section });

  const runResult = async (index: number) => {
    const item = results[index];
    if (!item) return;
    if (!canActOnIndex(index)) return;
    commandPaletteMruStore.record(item.id);
    overlayStore.close();
    if (item.action.kind === 'prefill') {
      composerDraftStore.request(item.action.text);
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
  const { innerWidth } = overlayRect({ cols, rows, density: PANEL_DENSITY });
  const labelWidth = Math.min(
    commandLabelWidth(commands),
    Math.floor(innerWidth * LABEL_COLUMN_SHARE),
  );
  const hint = canActOnIndex(cursor)
    ? ['↑↓ navigate', '⏎ run or fill in', 'esc close'].join(SOFT_SEP)
    : ['↑↓ navigate', 'esc close'].join(SOFT_SEP);

  return (
    <OverlayPanel hint={hint} density={PANEL_DENSITY}>
      <Box marginBottom={1}>
        <FilterInput filter={query} placeholder="Type a command…" />
      </Box>

      <Box flexDirection="column" height={listBudget}>
        <ListViewport
          items={results}
          selectedIndex={cursor}
          getKey={(result) => result.id}
          rowBudget={listBudget}
          rowZonePrefix="palette"
          showRemainingCount
          onRowActivate={(index) => {
            void runResult(index);
          }}
          section={{
            ...section,
            renderHeader: (label) => <Text color={t.textDim}>{label}</Text>,
          }}
          placeholder={<Text color={t.textDim}>No matching commands</Text>}
          renderItem={(result, ctx) => {
            // Command names share one column so the description edge holds still across screens.
            // A session or task title is the whole row, so it widens its own label instead of
            // being cut to the width of the longest command name.
            const rowLabelWidth =
              result.source === 'command'
                ? labelWidth
                : Math.max(
                    labelWidth,
                    Math.min(getTerminalCellWidth(result.label), innerWidth - STATUS_RESERVE),
                  );
            return (
              <ListRow
                label={result.label}
                state={ctx.isCursor ? 'active' : 'default'}
                metadata={descriptionColumn({
                  description: result.description,
                  hint: result.hint,
                  shortcut: result.shortcut,
                  innerWidth,
                  labelWidth: rowLabelWidth,
                })}
                {...(result.shortcut ? { trailing: result.shortcut } : {})}
                labelWidth={rowLabelWidth}
              />
            );
          }}
        />
      </Box>
    </OverlayPanel>
  );
}
