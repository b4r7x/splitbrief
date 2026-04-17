import { Box, Text } from 'ink';
import cfonts from 'cfonts';
import type { SlashCommandDef } from '../../core/types/app.js';
import { useTheme } from '../../components/theme.js';
import { InputBar } from '../../components/input-bar/index.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { HomeConfigSummary } from './components/config-summary.js';
import { RecentSessions } from './components/recent-sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getResponsivePanelWidth } from '../../core/layout/terminal-width.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { useStores } from '../../stores/use-stores.js';

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
  const [{ cols, isSmall }] = useStores(terminalSizeStore);

  const banner = getBanner();
  const contentWidth = getResponsivePanelWidth(cols, isSmall, { small: 70, large: 100 }, 8);
  const onStartWorkflow = (feat: string) => routerStore.navigate({ to: 'workflow', feature: feat });

  return (
    <ScreenShell justifyContent="center" alignItems="center">
      <Box flexDirection="column" width={contentWidth} gap={isSmall ? 0 : 1}>
        <Box justifyContent="center" marginBottom={1}>
          {banner ? (
            <Text>{banner.trimEnd()}</Text>
          ) : (
            <Text bold color={theme.accent}>diptych</Text>
          )}
        </Box>

        <HomeConfigSummary />

        <RecentSessions />

        <InputBar
          disabled={hasOverlay}
          onSubmit={onStartWorkflow}
          onSlashCommand={onSlashCommand}
          commands={commands}
          mode="normal"
          hint="describe your feature..."
          currentScreen='home'
          width={contentWidth}
        />
      </Box>
    </ScreenShell>
  );
}
