import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';

export function RecentSessionsShell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [{ isSmall }] = useStores(terminalSizeStore);
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={MARK_SLOT_CELLS}>
      <Box marginBottom={isSmall ? 0 : 1}>
        <Text color={theme.textDim}>Recent sessions</Text>
      </Box>
      {children}
    </Box>
  );
}
