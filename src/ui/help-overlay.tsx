import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { Screen } from '../types.js';
import { getShortcutsForScreen } from '../shortcuts.js';

interface HelpOverlayProps {
  onClose: () => void;
  theme: Theme;
  currentScreen: Screen;
}

export function HelpOverlay({ onClose, theme: t, currentScreen }: HelpOverlayProps) {
  const shortcuts = getShortcutsForScreen(currentScreen);

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={t.accent}>Help</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={t.text}>Commands</Text>
        <Box><Box width={14}><Text color={t.accent}>/help</Text></Box><Text color={t.textDim}>Show this help overlay</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>/status</Text></Box><Text color={t.textDim}>Show workflow status</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>/init</Text></Box><Text color={t.textDim}>Configure planner & model</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>/skills</Text></Box><Text color={t.textDim}>Select planner skills</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>/palette</Text></Box><Text color={t.textDim}>Open command palette</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>/quit</Text></Box><Text color={t.textDim}>Exit application</Text></Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={t.text}>Keyboard Shortcuts</Text>
        {shortcuts.map((s) => (
          <Box key={s.key}>
            <Box width={14}><Text color={t.accent}>{s.key}</Text></Box>
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
