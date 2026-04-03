import { Box, Text } from 'ink';
import { useAppContext } from '../app.js';
import { useTheme } from '../ui/theme.js';
import type { Screen } from '../types.js';
import { getShortcutsForScreen } from '../core/shortcuts.js';

const LABEL_COL_WIDTH = 14;

interface HelpOverlayProps {
  currentScreen: Screen;
}

export function HelpOverlay({ currentScreen }: HelpOverlayProps) {
  const t = useTheme();
  const { commands } = useAppContext();
  const shortcuts = getShortcutsForScreen(currentScreen);

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={t.accent}>Help</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={t.text}>Commands</Text>
        {commands.map((cmd) => (
          <Box key={cmd.name}>
            <Box width={LABEL_COL_WIDTH}><Text color={t.accent}>{cmd.name}</Text></Box>
            <Text color={t.textDim}>{cmd.description}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={t.text}>Keyboard Shortcuts</Text>
        {shortcuts.map((s) => (
          <Box key={s.key}>
            <Box width={LABEL_COL_WIDTH}><Text color={t.accent}>{s.key}</Text></Box>
            <Text color={t.textDim}>{s.description}</Text>
          </Box>
        ))}
      </Box>

      <Box justifyContent="center">
        <Text color={t.textDim}>Press Escape to close</Text>
      </Box>
    </Box>
  );
}
