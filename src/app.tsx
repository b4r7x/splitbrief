import React, { createContext, useContext, useState, useMemo, useCallback } from 'react';
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
import type { Theme } from './theme.js';
import type { WorkflowState, RouteData, CommandContext, Screen, SkillMeta, Config, SlashCommandDef } from './types.js';

interface AppContextValue {
  config: Config;
  theme: Theme;
  commands: SlashCommandDef[];
  errorMessage: string | null;
  onClearError: () => void;
  projectDir: string;
  availableSkills: SkillMeta[];
  selectedSkillIds: Set<string>;
  onSkillsConfirm: (ids: Set<string>) => void;
  selectedSkillMetas: SkillMeta[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppContext.Provider');
  return ctx;
}

interface AppProps {
  feature?: string;
  projectDir: string;
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  plannerOverride?: string;
  plannerModelOverride?: string;
  savedState?: WorkflowState;
}

export default function App({ feature, projectDir, modelOverride, providerOverride, contextLengthOverride, plannerOverride, plannerModelOverride, savedState }: AppProps) {
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

  const ctx = useMemo<CommandContext>(() => ({
    openOverlay: overlay.open,
    closeOverlay: overlay.close,
    showStatus: () => setErrorMessage('No active workflow'),
    quit: () => exit(),
  }), [overlay.open, overlay.close, exit]);
  const commands = useMemo(() => createCommands(ctx), [ctx]);
  const paletteItems = toPaletteItems(commands);
  const handleSlashCommand = (raw: string, from: Screen) =>
    executeSlashCommand(commands, raw, from, setErrorMessage);

  useGlobalKeys({ screen, overlay, exit, setErrorMessage });

  const onClearError = useCallback(() => setErrorMessage(null), []);
  const appContextValue = useMemo<AppContextValue>(() => ({
    config,
    theme,
    commands,
    errorMessage,
    onClearError,
    projectDir,
    availableSkills: skills.available,
    selectedSkillIds: skills.selected,
    onSkillsConfirm: skills.setSelected,
    selectedSkillMetas: skills.selectedMetas,
  }), [config, theme, commands, errorMessage, onClearError, projectDir, skills.available, skills.selected, skills.setSelected, skills.selectedMetas]);

  return (
    <AppContext.Provider value={appContextValue}>
      <Router
        screen={screen}
        routeData={routeData}
        overlayActive={overlay.active}
        onCloseOverlay={overlay.close}
        onOpenOverlay={overlay.open}
        sessions={sessions}
        paletteItems={paletteItems}
        onSlashCommand={handleSlashCommand}
        navigate={navigate}
      />
    </AppContext.Provider>
  );
}
