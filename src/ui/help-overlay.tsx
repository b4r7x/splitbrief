import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';

interface HelpOverlayProps {
  onClose: () => void;
  theme: Theme;
}

export function HelpOverlay({ onClose, theme: t }: HelpOverlayProps) {
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
        <Box><Box width={14}><Text color={t.accent}>/palette</Text></Box><Text color={t.textDim}>Open command palette</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>/sidebar</Text></Box><Text color={t.textDim}>Toggle task sidebar</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>/quit</Text></Box><Text color={t.textDim}>Exit application</Text></Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={t.text}>Keyboard Shortcuts</Text>
        <Box><Box width={14}><Text color={t.accent}>Ctrl+K</Text></Box><Text color={t.textDim}>Command palette</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>Ctrl+\</Text></Box><Text color={t.textDim}>Toggle sidebar</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>?</Text></Box><Text color={t.textDim}>Show help (workflow/summary)</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>d</Text></Box><Text color={t.textDim}>Toggle diff expand</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>q</Text></Box><Text color={t.textDim}>Quit</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>↑/↓</Text></Box><Text color={t.textDim}>Scroll conversation</Text></Box>
        <Box><Box width={14}><Text color={t.accent}>Escape</Text></Box><Text color={t.textDim}>Close overlay</Text></Box>
      </Box>

      <Box justifyContent="center">
        <Text color={t.textDim}>Press Escape to close</Text>
      </Box>
    </Box>
  );
}
