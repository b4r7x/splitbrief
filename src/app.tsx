import React, { useState } from 'react';
import { useApp } from 'ink';
import { useRouter } from './hooks/use-router.js';
import { useSessions } from './hooks/use-sessions.js';
import { useOverlay } from './hooks/use-overlay.js';
import { useConfig } from './hooks/use-config.js';
import { useSkills } from './hooks/use-skills.js';
import { createCommands, toPaletteItems, executeSlashCommand } from './commands.js';
import { useGlobalKeys } from './hooks/use-global-keys.js';
import { Router } from './router.js';
import { getTheme } from './theme.js';
import type { WorkflowState, RouteData, CommandContext, Screen, SkillMeta } from './types.js';

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
  const skills = useSkills(config.planner.tool, projectDir);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const ctx: CommandContext = {
    openOverlay: overlay.open,
    closeOverlay: overlay.close,
    showStatus: () => setErrorMessage('No active workflow'),
    quit: () => exit(),
  };
  const commands = createCommands(ctx);
  const paletteItems = toPaletteItems(commands);
  const handleSlashCommand = (raw: string, from: Screen) =>
    executeSlashCommand(commands, raw, from, setErrorMessage);

  useGlobalKeys({ screen, overlay, exit, setErrorMessage });

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
      commands={commands}
      errorMessage={errorMessage}
      onClearError={() => setErrorMessage(null)}
      onSlashCommand={handleSlashCommand}
      navigate={navigate}
      exit={exit}
      availableSkills={skills.available}
      selectedSkillIds={skills.selected}
      onSkillsConfirm={skills.setSelected}
      selectedSkillMetas={skills.selectedMetas}
    />
  );
}
