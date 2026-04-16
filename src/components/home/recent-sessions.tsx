import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { terminalSizeStore } from '../../stores/terminal-size.js';
import { sessionsStore } from '../../stores/sessions.js';
import { configStore } from '../../stores/config.js';
import { useStores } from '../../stores/use-stores.js';
import { formatRelativeTime } from '../../utils/format.js';
import { getSessionStatusDisplay } from '../../core/sessions/status.js';

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
      {sessions.map((s) => {
        const display = getSessionStatusDisplay(s.status, theme);
        return (
          <Box key={s.id}>
            <Text color={display.color}>{display.icon} </Text>
            <Text color={theme.text}>{s.feature}</Text>
            <Text color={theme.textDim}> {formatRelativeTime(s.startedAt)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
