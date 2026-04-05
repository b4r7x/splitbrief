import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';

type GutterRole = 'planner' | 'implementer';

export function Gutter({ role, children }: { role: GutterRole; children: React.ReactNode }) {
  const t = useTheme();
  const color = role === 'implementer' ? t.implementer : t.planner;
  const char = role === 'implementer' ? '┆' : '│';
  const indent = role === 'implementer' ? '  ' : '';

  return (
    <Box flexDirection="row">
      <Text color={color}>{indent}{char} </Text>
      <Box flexDirection="column" flexGrow={1}>{children}</Box>
    </Box>
  );
}
