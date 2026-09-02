import { useState } from 'react';
import { Box, useInput } from 'ink';
import { OverlayPanel, overlayInnerRowCapacity } from '../../components/overlays/overlay-panel.js';
import { ListGroupHeader, ListRow } from '../../components/list-row.js';
import { commandLabelWidth, descriptionColumn } from '../../components/list-columns.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import { SOFT_SEP } from '../../components/separators.js';
import { buildCommandItems } from '../../features/palette/sources.js';
import { getShortcutsForScreen } from '../../core/keybindings/registry.js';
import { resolveScrollKey, type ScrollKeyAction } from '../../core/keybindings/scroll.js';
import {
  OVERLAY_FRAME_ROWS,
  overlayRect,
  type OverlayDensity,
} from '../../core/navigation/overlay-rect.js';
import type { Screen } from '../../core/navigation/types.js';
import { detectedModelFact, seatSupportsImages } from '../../core/runners/capabilities.js';
import { COMMAND_CATEGORIES, COMMAND_CATEGORY_LABELS } from '../../core/runtime/commands/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { clamp } from '../../utils/math.js';
import { assertNever } from '../../utils/type-guards.js';

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
  shortcut: string | null;
  section: string;
}

function cursorForScrollAction(input: {
  action: ScrollKeyAction;
  cursor: number;
  page: number;
  lastIndex: number;
}): number {
  switch (input.action) {
    case 'line-up':
      return input.cursor - 1;
    case 'line-down':
      return input.cursor + 1;
    case 'page-up':
      return input.cursor - input.page;
    case 'page-down':
      return input.cursor + input.page;
    case 'top':
      return 0;
    case 'bottom':
      return input.lastIndex;
    default:
      return assertNever(input.action);
  }
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
  const phase = lifecycleStore.use((s) => s.phase);
  const route = routerStore.use((s) => s);

  const commandItems = buildCommandItems({
    commands,
    screen: currentScreen,
    onRuntimeCommand: () => {},
    guardContext: {
      phase,
      attached: route.screen === 'workflow' && route.execution.kind === 'attached',
      plannerSupportsImages:
        config !== null &&
        seatSupportsImages({
          runner: config.planner,
          detected: detectedModelFact(modelCacheStore.getDetection().providers, config.planner),
        }),
    },
  });
  const shortcuts = getShortcutsForScreen(currentScreen, { inputMode });

  const helpRows: HelpRow[] = [
    ...COMMAND_CATEGORIES.flatMap((category) =>
      commandItems
        .filter((item) => item.category === category)
        .map((item) => ({
          key: `command:${item.label}`,
          label: item.label,
          description: item.description,
          shortcut: item.shortcut,
          section: COMMAND_CATEGORY_LABELS[category],
        })),
    ),
    ...shortcuts.map((shortcut) => ({
      key: `shortcut:${shortcut.id}`,
      label: shortcut.key,
      description: shortcut.description,
      shortcut: null,
      section: SHORTCUTS_SECTION,
    })),
  ];

  const listBudget = overlayInnerRowCapacity({
    rows,
    outerChromeRows: HELP_CHROME_ROWS - OVERLAY_FRAME_ROWS,
  });
  const { innerWidth } = overlayRect({ cols, rows, density: PANEL_DENSITY });
  const labelWidth = commandLabelWidth(commands);

  // A scrolled list spends two of its budget rows on the up/down indicators, so a page step of
  // the full budget would carry the cursor past rows that were never rendered.
  const pageStep = Math.max(1, listBudget - 2);

  useInput((input, key) => {
    const action = resolveScrollKey({ input, key, lineKeys: 'plain' });
    if (action === null) return;
    const lastIndex = Math.max(0, helpRows.length - 1);
    setCursor((c) =>
      clamp(cursorForScrollAction({ action, cursor: c, page: pageStep, lastIndex }), 0, lastIndex),
    );
  });

  return (
    <OverlayPanel
      title="Help · commands & shortcuts"
      hint={`↑↓ scroll${SOFT_SEP}esc close`}
      titleSpacing="tight"
      density={PANEL_DENSITY}
    >
      <Box flexDirection="column" height={listBudget}>
        <ListViewport
          items={helpRows}
          selectedIndex={cursor}
          getKey={(row) => row.key}
          rowBudget={listBudget}
          showRemainingCount
          section={{
            by: (row) => row.section,
            headerFor: () => listBudget >= SECTION_HEADER_MIN_ROWS,
            renderHeader: (label) => <ListGroupHeader label={label} />,
          }}
          renderItem={(row) => {
            // Command names all fit the column, so it never moves for them. A keyboard chord is
            // spelled out (`shift+↑/↓, pgup/pgdn, home/end`) and teaching it is the whole point of
            // the row, so a chord past the column pushes its own description right instead of
            // being cut.
            const rowLabelWidth = Math.max(labelWidth, getTerminalCellWidth(row.label));
            return (
              <ListRow
                label={row.label}
                metadata={descriptionColumn({
                  description: row.description,
                  shortcut: row.shortcut,
                  innerWidth,
                  labelWidth: rowLabelWidth,
                })}
                {...(row.shortcut ? { trailing: row.shortcut } : {})}
                labelWidth={rowLabelWidth}
              />
            );
          }}
        />
      </Box>
    </OverlayPanel>
  );
}
