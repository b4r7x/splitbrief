import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { OverlayPanel } from './overlay-panel.js';
import type { Screen, SlashCommandDef } from '../../types.js';
import { getShortcutsForScreen } from '../../core/commands/shortcuts.js';

const PADDING_BORDER = 6;

interface HelpOverlayProps {
  currentScreen: Screen;
  commands: SlashCommandDef[];
}

export function HelpOverlay({ currentScreen, commands }: HelpOverlayProps) {
  const t = useTheme();
  const shortcuts = getShortcutsForScreen(currentScreen);
  const labelColWidth = Math.max(
    ...commands.map((c) => c.name.length),
    ...shortcuts.map((s) => s.key.length),
  ) + 2;
  const maxDescWidth = Math.max(
    ...commands.map((c) => c.description.length),
    ...shortcuts.map((s) => s.description.length),
  );

  return (
    <OverlayPanel
      title="Help"
      hint="Press Escape to close"
      maxWidth={labelColWidth + maxDescWidth + PADDING_BORDER}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={t.text}>Commands</Text>
        {commands.map((cmd) => (
          <Box key={cmd.name}>
            <Box width={labelColWidth}><Text color={t.accent}>{cmd.name}</Text></Box>
            <Text color={t.textDim}>{cmd.description}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold color={t.text}>Keyboard Shortcuts</Text>
        {shortcuts.map((s) => (
          <Box key={s.key}>
            <Box width={labelColWidth}><Text color={t.accent}>{s.key}</Text></Box>
            <Text color={t.textDim}>{s.description}</Text>
          </Box>
        ))}
      </Box>
    </OverlayPanel>
  );
}
