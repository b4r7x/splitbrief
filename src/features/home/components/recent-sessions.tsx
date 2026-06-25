import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { configStore } from '../../../stores/project/config.js';
import { useStores } from '../../../stores/use-stores.js';
import { SessionRow } from '../../../components/session-row.js';
import { SOFT_SEP } from '../../../components/separators.js';
import type { Session } from '../../../core/schemas/session.js';
import { RecentSessionsList } from './recent-sessions-list.js';
import { RecentSessionsShell } from './recent-sessions-shell.js';

interface RecentSessionsProps {
  limit?: number | undefined;
  showHiddenCount?: boolean | undefined;
  focused?: boolean | undefined;
  onSelect?: ((session: Session) => void) | undefined;
  onClose?: (() => void) | undefined;
  hasOverlay?: boolean | undefined;
}

export function RecentSessions({
  limit,
  showHiddenCount = true,
  focused,
  onSelect,
  onClose,
  hasOverlay,
}: RecentSessionsProps) {
  const [{ sessions, allSessions }, { projectDir }] = useStores(sessionsStore, configStore);
  const theme = useTheme();

  const shouldLoad = Boolean(focused) || limit === undefined || limit > 0;
  const shouldLoadAll = Boolean(focused && onSelect && onClose && shouldLoad);

  useEffect(() => {
    if (!shouldLoad) return;
    sessionsStore.load(projectDir);
  }, [projectDir, shouldLoad]);

  useEffect(() => {
    if (!shouldLoadAll) return;
    sessionsStore.loadAll(projectDir);
  }, [projectDir, shouldLoadAll]);

  if (!shouldLoad) return null;

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.textDim}>no recent sessions</Text>
      </Box>
    );
  }

  const visibleSessions = sessions.slice(0, limit ?? sessions.length);
  const hiddenCount = sessions.length - visibleSessions.length;

  if (focused && onSelect && onClose) {
    const focusedSessions = allSessions.length > 0 ? allSessions : sessions;
    return (
      <RecentSessionsList
        sessions={focusedSessions}
        hasOverlay={hasOverlay ?? false}
        onSelect={onSelect}
        onClose={onClose}
        maxVisible={limit}
      />
    );
  }

  return (
    <RecentSessionsShell>
      {visibleSessions.map((s) => (
        <SessionRow key={s.id} session={s} />
      ))}
      {showHiddenCount && hiddenCount > 0 && (
        <Box marginLeft={2}>
          <Text color={theme.text}>{hiddenCount} more</Text>
          <Text color={theme.textDim}>{SOFT_SEP}ctrl+r to show all</Text>
        </Box>
      )}
    </RecentSessionsShell>
  );
}
