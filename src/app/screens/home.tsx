import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useTheme } from '../../components/theme.js';
import { Composer } from '../../components/composer/composer.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { SOFT_SEP } from '../../components/separators.js';
import { HomeConfigSummary } from '../../features/home/components/config-summary.js';
import { RecentSessions } from '../../features/home/components/recent-sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import type { Session } from '../../core/schemas/session.js';
import { handleSessionSelect, sessionSelectStore } from '../../stores/navigation/session-select.js';
import { getHomeLayout } from '../../features/home/layout.js';
import { getLogo } from '../../features/home/logo.js';
import { RECENT_SESSIONS_HINT } from '../../features/home/components/recent-sessions-list.js';
import { useRecentSessionsFocus } from '../../features/home/use-recent-sessions-focus.js';

const DEFAULT_HOME_HINT = `/help${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+k commands`;
const HOME_HINT = `/help${SOFT_SEP}/settings${SOFT_SEP}/skills${SOFT_SEP}ctrl+r recent${SOFT_SEP}ctrl+k commands`;
const HOME_SELECTION_ERROR_CLEAR_MS = 3000;

interface HomeScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

export function HomeScreen({ commands, onRuntimeCommand }: HomeScreenProps) {
  const theme = useTheme();
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const [{ cols, rows, isSmall }, { sessions, totalCount }, { projectDir }] = useStores(
    terminalSizeStore,
    sessionsStore,
    configStore,
  );
  const selectionError = sessionSelectStore.use((s) => s.error);
  const [sessionsFocused, setSessionsFocused] = useState(false);
  const preliminaryLayout = getHomeLayout({
    cols,
    rows,
    isSmall,
    sessionCount: totalCount,
    sessionsFocused: false,
  });
  const focusedLayout = getHomeLayout({
    cols,
    rows,
    isSmall,
    sessionCount: totalCount,
    sessionsFocused: true,
  });
  const hasRoomForSessions = preliminaryLayout.recentSessionLimit > 0;
  const canFocus = focusedLayout.recentSessionLimit > 0 && sessions.length > 0;
  const sessionsActive = sessionsFocused && canFocus;
  const layout = sessionsActive ? focusedLayout : preliminaryLayout;

  useEffect(() => {
    if (!canFocus) setSessionsFocused(false);
  }, [canFocus]);

  useEffect(() => {
    if (!sessionsActive || !selectionError) return undefined;
    const timer = setTimeout(() => sessionSelectStore.clearError(), HOME_SELECTION_ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [sessionsActive, selectionError]);

  const closeRecentSessions = () => {
    setSessionsFocused(false);
    sessionSelectStore.clearError();
  };

  useRecentSessionsFocus({
    hasSessions: canFocus,
    hasOverlay,
    focused: sessionsActive,
    onEnter: () => setSessionsFocused(true),
  });
  const onStartWorkflow = (feat: string) => routerStore.navigate({ to: 'workflow', feature: feat });
  let homeHint: string | undefined;
  if (!hasOverlay) {
    homeHint = DEFAULT_HOME_HINT;
    if (canFocus) homeHint = HOME_HINT;
    if (sessionsActive) homeHint = RECENT_SESSIONS_HINT;
  }

  return (
    <ScreenShell justifyContent="flex-start" alignItems="center">
      <Box flexDirection="column" width={layout.inputWidth} height="100%">
        <Box flexDirection="column" flexGrow={1} overflowY="hidden" alignItems="center">
          <Box flexDirection="column" width={layout.bodyWidth} gap={1}>
            <Box flexDirection="column" alignItems="center" flexShrink={0}>
              <Text color={theme.accent}>{getLogo(layout.logoTier)}</Text>
            </Box>

            <HomeConfigSummary />

            {hasRoomForSessions && (
              <RecentSessions
                limit={layout.recentSessionLimit}
                showHiddenCount={layout.showHiddenCount}
                focused={sessionsActive}
                onSelect={(session: Session) => handleSessionSelect(session, projectDir)}
                onClose={closeRecentSessions}
                hasOverlay={hasOverlay}
              />
            )}
            {sessionsActive && (
              <Box height={1} overflow="hidden">
                {selectionError && (
                  <Text color={theme.error} wrap="truncate-end">
                    {selectionError}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        </Box>

        <Box flexDirection="column" marginBottom={layout.inputBottomMargin}>
          <Composer
            disabled={hasOverlay || sessionsActive}
            onSubmit={onStartWorkflow}
            onRuntimeCommand={onRuntimeCommand}
            commands={commands}
            mode="normal"
            hint="Describe your feature…"
            currentScreen="home"
            width={layout.inputWidth}
            homeHint={homeHint}
          />
        </Box>
      </Box>
    </ScreenShell>
  );
}
