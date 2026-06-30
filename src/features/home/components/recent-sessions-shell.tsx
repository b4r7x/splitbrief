import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';

export function RecentSessionsShell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [{ isSmall }] = useStores(terminalSizeStore);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={isSmall ? 0 : 1}>
        <Text color={theme.textDim}>RECENT SESSIONS</Text>
      </Box>
      {children}
    </Box>
  );
}
