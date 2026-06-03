import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { useTheme } from '../../components/theme.js';
import { Composer } from '../../components/composer/composer.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { HomeConfigSummary } from './components/config-summary.js';
import { RecentSessions } from './components/recent-sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { useStores } from '../../stores/use-stores.js';
import { skillsStore } from '../../stores/project/skills.js';
import type { Session } from '../../core/schemas/session.js';
import { handleSessionSelect } from '../../stores/navigation/session-select.js';
import { getHomeLayout } from './layout.js';
import { getLogo } from './logo.js';
import { useRecentSessionsFocus } from './use-recent-sessions-focus.js';

const DEFAULT_HOME_HINT = '/help /config /skills Ctrl+K';
const HOME_HINT = `Ctrl+R recent ${DEFAULT_HOME_HINT}`;
const RECENT_SESSIONS_HINT = '↑↓ navigate  Enter resume  Esc back';

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
  const hasSkills = skillsStore.use((s) => s.selected.size > 0);
  const [sessionsFocused, setSessionsFocused] = useState(false);

  const layout = getHomeLayout({ cols, rows, isSmall, hasSkills });
  const hasSessions = layout.recentSessionLimit > 0 && sessions.length > 0;

  useEffect(() => {
    if (!hasSessions) setSessionsFocused(false);
  }, [hasSessions]);

  const sessionsActive = sessionsFocused && hasSessions;

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
            <Box justifyContent="center" marginBottom={1}>
              <Text color={theme.accent}>{getLogo(layout.logoTier)}</Text>
            </Box>

            <HomeConfigSummary />

            <RecentSessions
              limit={layout.recentSessionLimit}
              focused={sessionsActive}
              onSelect={(session: Session) => handleSessionSelect(session, projectDir)}
              onClose={() => setSessionsFocused(false)}
              hasOverlay={hasOverlay}
            />
          </Box>
        </Box>

        <Box flexDirection="column" marginBottom={layout.inputBottomMargin}>
          <Composer
            disabled={hasOverlay || sessionsActive}
            onSubmit={onStartWorkflow}
            onRuntimeCommand={onRuntimeCommand}
            commands={commands}
            mode="normal"
            hint="describe your feature..."
            currentScreen="home"
            width={layout.inputWidth}
            homeHint={homeHint}
          />
        </Box>
      </Box>
    </ScreenShell>
  );
}
