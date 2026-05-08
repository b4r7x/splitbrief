import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { SessionRow } from '../../../components/session-row.js';

interface RecentSessionsProps {
  limit?: number | undefined;
  featureColWidth?: number | undefined;
}

export function RecentSessions({ limit, featureColWidth }: RecentSessionsProps) {
  const [{ sessions }, { isSmall }, { projectDir }] = useStores(
    sessionsStore,
    terminalSizeStore,
    configStore,
  );
  const theme = useTheme();

  useEffect(() => {
    if (limit !== undefined && limit <= 0) return;
    sessionsStore.load(projectDir);
  }, [projectDir, limit]);

  if (limit !== undefined && limit <= 0) return null;

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.textDim}>no recent sessions</Text>
      </Box>
    );
  }

  const visibleSessions = sessions.slice(0, limit ?? sessions.length);
  const hiddenCount = sessions.length - visibleSessions.length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={isSmall ? 0 : 1}>
        <Text color={theme.textDim}>Recent sessions</Text>
      </Box>
      {visibleSessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          {...(featureColWidth !== undefined ? { featureColWidth } : {})}
        />
      ))}
      {hiddenCount > 0 && (
        <Text color={theme.textDim}>  +{hiddenCount} more</Text>
      )}
    </Box>
  );
}
