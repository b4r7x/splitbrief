import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { SessionRow } from '../../../components/session-row.js';

export function RecentSessions() {
  const [{ sessions }, { isSmall }, { projectDir }] = useStores(
    sessionsStore,
    terminalSizeStore,
    configStore,
  );
  const theme = useTheme();

  useEffect(() => {
    sessionsStore.load(projectDir);
  }, [projectDir]);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.textDim}>no recent sessions</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={isSmall ? 0 : 1}>
        <Text color={theme.textDim}>Recent sessions</Text>
      </Box>
      {sessions.map((s) => (
        <SessionRow key={s.id} session={s} />
      ))}
    </Box>
  );
}
