import React, { useState } from 'react';
import { useInput, useApp } from 'ink';
import { useRouter } from './hooks/use-router.js';
import { useSessions } from './hooks/use-sessions.js';
import { useOverlay } from './hooks/use-overlay.js';
import { useConfig } from './hooks/use-config.js';
import { useAppCommands } from './hooks/use-app-commands.js';
import { useCtrlC } from './hooks/use-ctrl-c.js';
import { Router } from './router.js';
import { getTheme } from './theme.js';
import type { WorkflowState, RouteData } from './types.js';

interface AppProps {
  feature?: string;
  projectDir: string;
  auto: boolean;
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  plannerOverride?: string;
  plannerModelOverride?: string;
  savedState?: WorkflowState;
}

export default function App({ feature, projectDir, auto, modelOverride, providerOverride, contextLengthOverride, plannerOverride, plannerModelOverride, savedState }: AppProps) {
  const initialRoute: RouteData | undefined = feature
    ? { screen: 'workflow', feature, resumeState: savedState }
    : undefined;

  const { screen, routeData, navigate } = useRouter(initialRoute);
  const { exit } = useApp();
  const overlay = useOverlay();
  const config = useConfig(projectDir, { modelOverride, providerOverride, contextLengthOverride, plannerOverride, plannerModelOverride });
  const theme = getTheme(config.theme);
  const sessionsScope = config.sessions?.scope ?? 'project';
  const { sessions } = useSessions(sessionsScope, projectDir);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { paletteItems, handleSlashCommand } = useAppCommands(overlay, screen, exit, setErrorMessage);

  useCtrlC(screen, exit, setErrorMessage);

  useInput((input, key) => {
    if (key.escape && overlay.isOpen) {
      overlay.close();
      return;
    }
    if (key.ctrl && input === 'k' && !overlay.isOpen) {
      overlay.open('command-palette');
    }
  });

  return (
    <Router
      screen={screen}
      routeData={routeData}
      overlayActive={overlay.active}
      onCloseOverlay={overlay.close}
      onOpenOverlay={overlay.open}
      config={config}
      theme={theme}
      sessions={sessions}
      auto={auto}
      projectDir={projectDir}
      paletteItems={paletteItems}
      errorMessage={errorMessage}
      onClearError={() => setErrorMessage(null)}
      onSlashCommand={handleSlashCommand}
      navigate={navigate}
      exit={exit}
    />
  );
}
