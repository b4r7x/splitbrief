import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import type { Screen, SlashCommandDef } from '../types.js';
import { getShortcutsForScreen } from '../core/shortcuts.js';

const PADDING_BORDER = 6;

interface HelpOverlayProps {
  currentScreen: Screen;
  commands: SlashCommandDef[];
}

export function HelpOverlay({ currentScreen, commands }: HelpOverlayProps) {
  const t = useTheme();
  const { cols, rows } = useResponsiveLayout();
  const shortcuts = getShortcutsForScreen(currentScreen);
  const labelColWidth = Math.max(
    ...commands.map((c) => c.name.length),
    ...shortcuts.map((s) => s.key.length),
  ) + 2;
  const maxDescWidth = Math.max(
    ...commands.map((c) => c.description.length),
    ...shortcuts.map((s) => s.description.length),
  );
  const contentWidth = Math.min(cols - 4, labelColWidth + maxDescWidth + PADDING_BORDER);

  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={contentWidth}
        borderStyle="round"
        borderColor={t.border}
        paddingX={2}
        paddingY={1}
      >
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>Help</Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={t.text}>Commands</Text>
          {commands.map((cmd) => (
            <Box key={cmd.name}>
              <Box width={labelColWidth}><Text color={t.accent}>{cmd.name}</Text></Box>
              <Text color={t.textDim}>{cmd.description}</Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={t.text}>Keyboard Shortcuts</Text>
          {shortcuts.map((s) => (
            <Box key={s.key}>
              <Box width={labelColWidth}><Text color={t.accent}>{s.key}</Text></Box>
              <Text color={t.textDim}>{s.description}</Text>
            </Box>
          ))}
        </Box>

        <Box justifyContent="center">
          <Text color={t.textDim}>Press Escape to close</Text>
        </Box>
      </Box>
    </Box>
  );
}
