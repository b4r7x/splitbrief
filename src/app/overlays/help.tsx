import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { ListGroupHeader, ListRow } from '../../components/list-row.js';
import {
  ScrollableDocument,
  type ScrollableDocumentRow,
} from '../../components/scrollable-document.js';
import type { Screen } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { getShortcutsForScreen } from '../../core/keybindings/registry.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { controlsStore } from '../../stores/ui/controls.js';

// OverlayPanel round border (2) + paddingX=2 (4), plus each ListRow's lead (2) and the metadata
// leading space (1) so the widest label+description pair fits inside the frame without truncation.
const PADDING_BORDER = 9;
const HELP_CHROME_ROWS = 11;

interface HelpOverlayProps {
  currentScreen: Screen;
  commands: RuntimeCommandDef[];
}

export function HelpOverlay({ currentScreen, commands }: HelpOverlayProps) {
  const rows = terminalSizeStore.use((s) => s.rows);
  const inputMode = controlsStore.use((s) => s.inputMode);
  const visibleCommands = commands.filter((command) =>
    command.validScreens.includes(currentScreen),
  );
  const shortcuts = getShortcutsForScreen(currentScreen, { inputMode });
  const labelColWidth =
    Math.max(
      0,
      ...visibleCommands.map((c) => c.name.length),
      ...shortcuts.map((s) => s.key.length),
    ) + 2;
  const maxDescWidth = Math.max(
    0,
    ...visibleCommands.map((c) => c.description.length),
    ...shortcuts.map((s) => s.description.length),
  );
  const documentRows: ScrollableDocumentRow[] = [
    {
      key: 'commands-heading',
      node: <ListGroupHeader label="commands" />,
    },
    ...visibleCommands.map((cmd) => ({
      key: `command:${cmd.name}`,
      node: <ListRow label={cmd.name} metadata={cmd.description} labelWidth={labelColWidth} />,
    })),
    {
      key: 'shortcuts-heading',
      node: <ListGroupHeader label="keyboard shortcuts" />,
    },
    ...shortcuts.map((shortcut) => ({
      key: `shortcut:${shortcut.id}`,
      node: (
        <ListRow label={shortcut.key} metadata={shortcut.description} labelWidth={labelColWidth} />
      ),
    })),
  ];

  return (
    <OverlayPanel
      title="help · commands & shortcuts"
      hint="↑↓ scroll · esc close"
      maxWidth={labelColWidth + maxDescWidth + PADDING_BORDER}
    >
      <ScrollableDocument
        rows={documentRows}
        height={Math.max(1, rows - HELP_CHROME_ROWS)}
        keyboardMode="line-and-page"
      />
    </OverlayPanel>
  );
}
