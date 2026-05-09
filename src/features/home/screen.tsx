import { Box, Text } from 'ink';
import cfonts from 'cfonts';
import type { SlashCommandDef } from '../../core/slash-commands/types.js';
import { useTheme } from '../../components/theme.js';
import { InputBar } from '../../components/input-bar/input-bar.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { HomeConfigSummary } from './components/config-summary.js';
import { RecentSessions } from './components/recent-sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { useStores } from '../../stores/use-stores.js';
import { getHomeLayout } from './layout.js';

let cachedBanner: string | undefined;

function getBanner(): string {
  if (cachedBanner !== undefined) return cachedBanner;
  const result = cfonts.render('diptych', { font: 'tiny', colors: ['cyan'] });
  cachedBanner = result ? result.string : '';
  return cachedBanner;
}

interface HomeScreenProps {
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
}

export function HomeScreen({ commands, onSlashCommand }: HomeScreenProps) {
  const theme = useTheme();
  const hasOverlay = overlayStore.use(s => s.active !== 'none');
  const [{ cols, rows, isSmall }] = useStores(terminalSizeStore);

  const banner = getBanner();
  const layout = getHomeLayout({ cols, rows, isSmall });
  const onStartWorkflow = (feat: string) => routerStore.navigate({ to: 'workflow', feature: feat });

  return (
    <ScreenShell justifyContent="flex-start" alignItems="center">
      <Box flexDirection="column" width={layout.inputWidth} height="100%">
        <Box
          flexDirection="column"
          flexGrow={1}
          overflowY="hidden"
          justifyContent={layout.mainJustifyContent}
          alignItems="center"
        >
          <Box flexDirection="column" width={layout.bodyWidth} gap={isSmall ? 0 : 1}>
            <Box justifyContent="center" marginBottom={1}>
              {layout.showBanner && banner ? (
                <Text>{banner.trimEnd()}</Text>
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
          <InputBar
            disabled={hasOverlay}
            onSubmit={onStartWorkflow}
            onSlashCommand={onSlashCommand}
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
