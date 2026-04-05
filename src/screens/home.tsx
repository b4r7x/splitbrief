import { Box, Text } from 'ink';
import cfonts from 'cfonts';
import type { Session, SlashCommandDef } from '../types.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { InputBar } from '../components/input-bar.js';
import { formatRelativeTime } from '../utils/format.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { configStore } from '../stores/config.js';
import { getProvider } from '../engine/providers/registry.js';
import { skillsStore } from '../stores/skills.js';
import { sessionsStore } from '../stores/sessions.js';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';

let cachedBanner: string | undefined;

function getBanner(): string {
  if (cachedBanner !== undefined) return cachedBanner;
  try {
    const result = cfonts.render('tiny-spec', { font: 'tiny', colors: ['cyan'] });
    cachedBanner = result ? result.string : '';
  } catch {
    cachedBanner = '';
  }
  return cachedBanner;
}

function statusIcon(status: Session['status']): string {
  switch (status) {
    case 'complete':
      return '\u2713';
    case 'interrupted':
      return '\u25cb';
    case 'failed':
      return '\u2717';
  }
}

function statusColor(status: Session['status'], theme: Theme): string {
  switch (status) {
    case 'complete':
      return theme.success;
    case 'interrupted':
      return theme.warning;
    case 'failed':
      return theme.error;
  }
}

interface HomeScreenProps {
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
}

export function HomeScreen({ commands, onSlashCommand }: HomeScreenProps) {
  const theme = useTheme();
  const config = configStore.use(s => s.config);
  const selectedSkillIds = skillsStore.use(s => s.selected);
  const sessions = sessionsStore.use(s => s.sessions);
  const hasOverlay = overlayStore.use(s => s.active !== 'none');
  const { cols, rows, isSmall } = useResponsiveLayout();
  if (!config) return null;

  const selectedSkillCount = selectedSkillIds.size;
  const banner = getBanner();
  const contentWidth = Math.min(cols - 8, isSmall ? 70 : 100);

  const onStartWorkflow = (feat: string) => routerStore.navigate('workflow', { feature: feat });

  return (
    <Box
      flexDirection="column"
      width={cols}
      height={rows}
      justifyContent="center"
      alignItems="center"
    >
      <Box flexDirection="column" width={contentWidth} gap={isSmall ? 0 : 1}>
        <Box justifyContent="center" marginBottom={1}>
          {banner ? (
            <Text>{banner.trimEnd()}</Text>
          ) : (
            <Text bold color={theme.accent}>tiny-spec</Text>
          )}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.textDim}>{'Planner'.padEnd(14)}</Text>
            <Text color={theme.planner}>{config.planner.tool}</Text>
            {config.planner.model && (
              <Text color={theme.planner}> › {config.planner.model}</Text>
            )}
            <Text color={theme.textDim}>  /planner</Text>
          </Box>
          <Box>
            <Text color={theme.textDim}>{'Implementer'.padEnd(14)}</Text>
            <Text color={theme.implementer}>{config.implementer.provider}</Text>
            <Text color={theme.textDim}> › </Text>
            <Text color={theme.implementer}>{config.implementer.model}</Text>
            {getProvider(config.implementer.provider).isLocal && (
              <Text color={theme.textDim}> (local)</Text>
            )}
            <Text color={theme.textDim}>  /implementer</Text>
          </Box>
          <Box>
            <Text color={theme.textDim}>{'Mode'.padEnd(14)}</Text>
            <Text color={theme.text}>{config.workflow.mode ?? 'standard'}</Text>
            <Text color={theme.textDim}>  /mode</Text>
          </Box>
          {selectedSkillCount > 0 && (
            <Box>
              <Text color={theme.textDim}>{'Skills'.padEnd(14)}</Text>
              <Text color={theme.accent}>{selectedSkillCount} active</Text>
              <Text color={theme.textDim}>  /skills</Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          {sessions.length > 0 ? (
            <>
              <Box marginBottom={isSmall ? 0 : 1}>
                <Text color={theme.textDim}>Recent sessions</Text>
              </Box>
              {sessions.map((s) => (
                <Box key={s.id}>
                  <Text color={statusColor(s.status, theme)}>
                    {statusIcon(s.status)}{' '}
                  </Text>
                  <Text color={theme.text}>{s.feature}</Text>
                  <Text color={theme.textDim}> {formatRelativeTime(s.startedAt)}</Text>
                </Box>
              ))}
            </>
          ) : (
            <Text color={theme.textDim}>no recent sessions</Text>
          )}
        </Box>

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
    </Box>
  );
}
