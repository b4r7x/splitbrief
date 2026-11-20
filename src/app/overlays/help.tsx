import { useState } from 'react';
import { Box, useInput } from 'ink';
import { OverlayPanel } from '../../components/overlays/panel.js';
import { ListRows, planViewportRows } from '../../components/list-row/rows.js';
import { CLOSE_HINT, formatKeyHints, SCROLL_HINT } from '../../components/key-legend.js';
import { buildCommandItems } from '../../features/palette/sources.js';
import { readLatestDiffKey } from '../../features/workflow/conversation-rows/row-actions/read.js';
import { getShortcutsForScreen } from '../../core/keybindings/registry.js';
import { resolveScrollKey, stepForScrollAction } from '../../core/keybindings/scroll.js';
import {
  OVERLAY_FRAME_ROWS,
  overlayInnerRowCapacity,
  overlayRect,
  type OverlayDensity,
} from '../../core/navigation/overlay-rect.js';
import type { Screen } from '../../core/navigation/types.js';
import { plannerSupportsImages } from '../../engine/providers/capabilities.js';
import { COMMAND_CATEGORIES, COMMAND_CATEGORY_LABELS } from '../../core/runtime/commands/types.js';
import type { CommandGuardContext, RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import {
  isApplyUnfinishedAtRest,
  isOpenRunAtRest,
  routerStore,
} from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { eventsStore } from '../../stores/workflow/events/state.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import { activeApply } from '../../engine/orchestrator/session-lifecycle/shutdown.js';

const PANEL_DENSITY: OverlayDensity = 'roomy';
// border, pad, title, blank, hint, pad, border — the panel is asked for a tight title, so the
// blank row it would otherwise spend under the title goes to the list instead.
const HELP_CHROME_ROWS = 7;
// Below this budget a header costs more rows than it organises, so the 60x18 help keeps the
// category order but drops the labels (§Target frames).
const SECTION_HEADER_MIN_ROWS = 12;
const SHORTCUTS_SECTION = 'Keyboard shortcuts';

interface HelpRow {
  key: string;
  label: string;
  description: string;
  /** The argument grammar, a cell of its own so the row can drop it whole rather than cut it. */
  hint: string | null;
  shortcut: string | null;
  section: string;
}

interface HelpOverlayProps {
  currentScreen: Screen;
  commands: RuntimeCommandDef[];
}

export function HelpOverlay({ currentScreen, commands }: HelpOverlayProps) {
  const [cursor, setCursor] = useState(0);
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const inputMode = controlsStore.use((s) => s.inputMode);
  const config = configStore.use((s) => s.config);
  const phase = runViewStore.use((s) => s.phase);
  const openRunAtRest = routerStore.use(isOpenRunAtRest);
  const applyUnfinished = routerStore.use(isApplyUnfinishedAtRest);

  const guardContext: CommandGuardContext = {
    phase,
    plannerSupportsImages: plannerSupportsImages(config, modelCacheStore),
    openRunAtRest,
    applyUnfinished,
    applying: activeApply() !== undefined,
  };
  const commandItems = buildCommandItems({
    commands,
    screen: currentScreen,
    onRuntimeCommand: () => {},
    guardContext,
  });
  // `ctrl+d` is taught only while a row of the transcript has details to show or hide.
  const hasDetails = eventsStore.use(() => readLatestDiffKey() !== null);
  const shortcuts = getShortcutsForScreen(currentScreen, { inputMode }).filter(
    (shortcut) => shortcut.id !== 'toggle-diff' || hasDetails,
  );

  const helpRows: HelpRow[] = [
    ...COMMAND_CATEGORIES.flatMap((category) =>
      commandItems
        .filter((item) => item.category === category)
        .map((item) => ({
          key: `command:${item.label}`,
          label: item.label,
          description: item.description,
          hint: item.hint,
          shortcut: item.shortcut,
          section: COMMAND_CATEGORY_LABELS[category],
        })),
    ),
    ...shortcuts.map((shortcut) => ({
      key: `shortcut:${shortcut.id}`,
      label: shortcut.key,
      description: shortcut.description,
      hint: null,
      shortcut: null,
      section: SHORTCUTS_SECTION,
    })),
  ];

  const listBudget = overlayInnerRowCapacity({
    rows,
    outerChromeRows: HELP_CHROME_ROWS - OVERLAY_FRAME_ROWS,
  });
  const { innerWidth } = overlayRect({ cols, rows, density: PANEL_DENSITY });
  const section =
    listBudget >= SECTION_HEADER_MIN_ROWS ? (i: number) => helpRows[i]?.section ?? '' : undefined;
  const lines = planViewportRows(
    helpRows.map((row) => ({
      name: row.label,
      wrapName: row.section === SHORTCUTS_SECTION,
      description: row.description,
      hint: row.hint,
      trailing: row.shortcut,
      group: row.section === SHORTCUTS_SECTION ? 'shortcuts' : 'commands',
    })),
    innerWidth,
    listBudget,
    section,
  );

  // A scrolled list spends two of its budget rows on the up/down indicators, so a page step of
  // the full budget would carry the cursor past rows that were never rendered.
  const pageStep = Math.max(1, listBudget - 2);

  useInput((input, key) => {
    const action = resolveScrollKey({ input, key, lineKeys: 'plain' });
    if (action === null) return;
    const lastIndex = Math.max(0, lines.length - 1);
    setCursor((c) => stepForScrollAction({ action, position: c, page: pageStep, last: lastIndex }));
  });

  return (
    <OverlayPanel
      title="Help · commands & shortcuts"
      hint={formatKeyHints([SCROLL_HINT, CLOSE_HINT])}
      titleSpacing="tight"
      density={PANEL_DENSITY}
    >
      <Box flexDirection="column" height={listBudget}>
        <ListRows
          lines={lines}
          selectedIndex={-1}
          scrollIndex={cursor}
          focused={false}
          getKey={(i) => helpRows[i]?.key ?? ''}
          rowBudget={listBudget}
          width={innerWidth}
          showRemainingCount
          section={section}
        />
      </Box>
    </OverlayPanel>
  );
}
