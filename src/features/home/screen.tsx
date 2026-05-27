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
import { useStores } from '../../stores/use-stores.js';
import { getHomeLayout } from './layout.js';
import { FULL_LOGO, SMALL_LOGO } from './logo.js';

interface HomeScreenProps {
  commands: RuntimeCommandDef[];
  onRuntimeCommand: (command: string) => void;
}

export function HomeScreen({ commands, onRuntimeCommand }: HomeScreenProps) {
  const theme = useTheme();
  const hasOverlay = overlayStore.use(s => s.active !== 'none');
  const [{ cols, rows, isSmall }] = useStores(terminalSizeStore);

  const layout = getHomeLayout({ cols, rows, isSmall });
  const onStartWorkflow = (feat: string) => routerStore.navigate({ to: 'workflow', feature: feat });

  return (
    <ScreenShell justifyContent="flex-start" alignItems="center">
      <Box flexDirection="column" width={layout.inputWidth} height="100%">
        <Box
          flexDirection="column"
          flexGrow={1}
          overflowY="hidden"
          alignItems="center"
        >
          <Box flexDirection="column" width={layout.bodyWidth} gap={isSmall ? 0 : 1}>
            <Box justifyContent="center" marginBottom={1}>
              {layout.logoTier === 'full' ? (
                <Text color={theme.accent}>{FULL_LOGO}</Text>
              ) : layout.logoTier === 'small' ? (
                <Text bold color={theme.accent}>{SMALL_LOGO}</Text>
              ) : (
                <Text bold color={theme.accent}>diptych</Text>
              )}
            </Box>

            <HomeConfigSummary />

            <RecentSessions
              limit={layout.recentSessionLimit}
              featureColWidth={layout.recentFeatureColWidth}
            />
          </Box>
        </Box>

        <Box flexDirection="column" marginBottom={layout.inputBottomMargin}>
          <Composer
            disabled={hasOverlay}
            onSubmit={onStartWorkflow}
            onRuntimeCommand={onRuntimeCommand}
            commands={commands}
            mode="normal"
            hint="describe your feature..."
            currentScreen="home"
            width={layout.inputWidth}
          />
        </Box>
      </Box>
    </ScreenShell>
  );
}
