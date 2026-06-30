import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useTheme } from '../../components/theme.js';
import { Composer } from '../../components/composer/composer.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { HomeConfigSummary } from '../../features/home/components/config-summary.js';
import { RecentSessions } from '../../features/home/components/recent-sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import { skillsStore } from '../../stores/project/skills.js';
import type { Session } from '../../core/schemas/session.js';
import { handleSessionSelect, sessionSelectStore } from '../../stores/navigation/session-select.js';
import { getHomeLayout } from '../../features/home/layout.js';
import { getLogo, LOGO_TAGLINE } from '../../features/home/logo.js';
import { useRecentSessionsFocus } from '../../features/home/use-recent-sessions-focus.js';

const DEFAULT_HOME_HINT = '/help · /config · /skills · ctrl+k';
const HOME_HINT = '/help · /config · /skills · ctrl+r recent · ctrl+k';
const RECENT_SESSIONS_HINT = '↑↓ navigate · type filter · enter resume/view · esc back';
const HOME_SELECTION_ERROR_CLEAR_MS = 3000;

interface HomeScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

export function HomeScreen({ commands, onRuntimeCommand }: HomeScreenProps) {
  const theme = useTheme();
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');
  const [{ cols, rows, isSmall }, { sessions }, { projectDir }] = useStores(
    terminalSizeStore,
    sessionsStore,
    configStore,
  );
  const selectionError = sessionSelectStore.use((s) => s.error);
  const [sessionsFocused, setSessionsFocused] = useState(false);
  const hasSkills = skillsStore.use((s) => s.selected.size > 0);
  const preliminaryLayout = getHomeLayout({
    cols,
    rows,
    isSmall,
    hasSkills,
    sessionCount: sessions.length,
    sessionsFocused: false,
  });
  const hasSessions = preliminaryLayout.recentSessionLimit > 0 && sessions.length > 0;
  const sessionsActive = sessionsFocused && hasSessions;
  const layout = getHomeLayout({
    cols,
    rows,
    isSmall,
    hasSkills,
    sessionCount: sessions.length,
    sessionsFocused: sessionsActive,
  });

  useEffect(() => {
    if (!hasSessions) setSessionsFocused(false);
  }, [hasSessions]);

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
    hasSessions,
    hasOverlay,
    focused: sessionsActive,
    onEnter: () => setSessionsFocused(true),
  });
  const onStartWorkflow = (feat: string) => routerStore.navigate({ to: 'workflow', feature: feat });
  let homeHint: string | undefined;
  if (!hasOverlay) {
    homeHint = DEFAULT_HOME_HINT;
    if (hasSessions) homeHint = HOME_HINT;
    if (sessionsActive) homeHint = RECENT_SESSIONS_HINT;
  }

  return (
    <ScreenShell justifyContent="flex-start" alignItems="center">
      <Box flexDirection="column" width={layout.inputWidth} height="100%">
        <Box flexDirection="column" flexGrow={1} overflowY="hidden" alignItems="center">
          <Box flexDirection="column" width={layout.bodyWidth} gap={isSmall ? 0 : 1}>
            <Box flexDirection="column" alignItems="center" marginBottom={1}>
              <Text color={theme.accent}>{getLogo(layout.logoTier)}</Text>
              <Text color={theme.textDim}>{LOGO_TAGLINE}</Text>
            </Box>

            <HomeConfigSummary />

            <RecentSessions
              limit={layout.recentSessionLimit}
              showHiddenCount={layout.showHiddenCount}
              focused={sessionsActive}
              onSelect={(session: Session) => handleSessionSelect(session, projectDir)}
              onClose={closeRecentSessions}
              hasOverlay={hasOverlay}
            />
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
            hint="describe your feature…"
            currentScreen="home"
            width={layout.inputWidth}
            homeHint={homeHint}
          />
        </Box>
      </Box>
    </ScreenShell>
  );
}
