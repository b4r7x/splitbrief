import React from 'react';
import { Box, Text, useStdout } from 'ink';
import cfonts from 'cfonts';
import type { Config, Session, Screen } from '../../types.js';
import type { Theme } from '../../theme.js';
import { InputBar } from '../input-bar.js';

let cachedBanner: string | undefined;

function getBanner(): string {
  if (cachedBanner !== undefined) return cachedBanner;
  try {
    const result = cfonts.render('tiny-spec', { font: 'tiny', colors: ['cyan'] });
    cachedBanner = result && typeof result === 'object' && 'string' in result ? (result as { string: string }).string : '';
  } catch {
    cachedBanner = '';
  }
  return cachedBanner;
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 60) return 'just now';

  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function statusIcon(status: Session['status']): string {
  switch (status) {
    case 'complete': return '\u2713';
    case 'interrupted': return '\u25cb';
    case 'failed': return '\u2717';
  }
}

function statusColor(status: Session['status'], theme: Theme): string {
  switch (status) {
    case 'complete': return theme.success;
    case 'interrupted': return theme.warning;
    case 'failed': return theme.error;
  }
}

interface HomeScreenProps {
  config: Config;
  sessions: Session[];
  onStartWorkflow: (feature: string) => void;
  onSlashCommand?: (command: string) => void;
  onOpenOverlay?: (type: import('../../types.js').OverlayType) => void;
  errorMessage?: string | null;
  onClearError?: () => void;
  theme: Theme;
}

export function HomeScreen({ config, sessions, onStartWorkflow, onSlashCommand, onOpenOverlay, errorMessage, onClearError, theme }: HomeScreenProps) {
  const banner = getBanner();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  return (
    <Box flexDirection="column" height={rows} justifyContent="center" alignItems="center">
    <Box flexDirection="column" width={Math.min(stdout?.columns || 80, 80)} gap={1}>
      {banner ? (
        <Box>
          <Text>{banner.trimEnd()}</Text>
        </Box>
      ) : (
        <Box>
          <Text bold color={theme.accent}>tiny-spec</Text>
        </Box>
      )}

      <Box flexDirection="column">
        <Box>
          <Text color={theme.textDim}>Planner: </Text>
          <Text color={theme.planner}>{config.planner.tool}</Text>
          {config.planner.model && (
            <Text color={theme.textDim}> ({config.planner.model})</Text>
          )}
        </Box>
        <Box>
          <Text color={theme.textDim}>Model:   </Text>
          <Text color={theme.implementer}>{config.implementer.model}</Text>
          <Text color={theme.textDim}> ({config.implementer.provider})</Text>
          <Text color={theme.textDim}>  /init to change</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        {sessions.length > 0 ? (
          <>
            <Box marginBottom={0}>
              <Text color={theme.textDim}>Recent sessions</Text>
            </Box>
            {sessions.map((s) => (
              <Box key={s.id}>
                <Text color={statusColor(s.status, theme)}>{statusIcon(s.status)} </Text>
                <Text color={theme.text}>{s.feature}</Text>
                <Text color={theme.textDim}>  {formatRelativeTime(s.startedAt)}</Text>
              </Box>
            ))}
          </>
        ) : (
          <Text color={theme.textDim}>no recent sessions</Text>
        )}
      </Box>

      <InputBar
        onSubmit={onStartWorkflow}
        onSlashCommand={onSlashCommand}
        errorMessage={errorMessage}
        onClearError={onClearError}
        mode="normal"
        hint="describe your feature..."
        currentScreen={'home' as Screen}
        theme={theme}
      />
    </Box>
    </Box>
  );
}
