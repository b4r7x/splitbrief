import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import {
  ScrollableDocument,
  type ScrollableDocumentRow,
} from '../../components/scrollable-document.js';
import type { Screen } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { getShortcutsForScreen } from '../../core/keybindings/registry.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { controlsStore } from '../../stores/ui/controls.js';

const PADDING_BORDER = 6;
const HELP_CHROME_ROWS = 11;

interface HelpOverlayProps {
  currentScreen: Screen;
  commands: RuntimeCommandDef[];
}

export function HelpOverlay({ currentScreen, commands }: HelpOverlayProps) {
  const t = useTheme();
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
      node: (
        <Text bold color={t.text}>
          Commands
        </Text>
      ),
    },
    ...visibleCommands.map((cmd) => ({
      key: `command:${cmd.name}`,
      node: (
        <>
          <Box width={labelColWidth}>
            <Text color={t.accent}>{cmd.name}</Text>
          </Box>
          <Text color={t.textDim}>{cmd.description}</Text>
        </>
      ),
    })),
    {
      key: 'shortcuts-heading',
      node: (
        <Text bold color={t.text}>
          Keyboard Shortcuts
        </Text>
      ),
    },
    ...shortcuts.map((shortcut) => ({
      key: `shortcut:${shortcut.id}`,
      node: (
        <>
          <Box width={labelColWidth}>
            <Text color={t.accent}>{shortcut.key}</Text>
          </Box>
          <Text color={t.textDim}>{shortcut.description}</Text>
        </>
      ),
    })),
  ];

  return (
    <OverlayPanel
      title="Help"
      hint="↑↓/PgUp/PgDn scroll  Esc close"
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
