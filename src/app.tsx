import { createContext, useContext, useState } from 'react';
import { useApp } from 'ink';
import { useRouter } from './hooks/use-router.js';
import { useSessions } from './hooks/use-sessions.js';
import { useOverlay } from './hooks/use-overlay.js';
import { useConfig } from './hooks/use-config.js';
import { useSkills } from './hooks/use-skills.js';
import { createCommands, toPaletteItems, executeSlashCommand } from './core/commands.js';
import { useGlobalKeys } from './hooks/use-global-keys.js';
import { Router } from './router.js';
import { ThemeProvider, getTheme } from './ui/theme.js';
import type { WorkflowState, RouteData, CommandContext, Screen, SkillMeta, Config, SlashCommandDef } from './types.js';

interface AppContextValue {
  config: Config;
  reloadConfig: () => void;
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
  const { config, reloadConfig } = useConfig(projectDir, { modelOverride, providerOverride, contextLengthOverride, plannerOverride, plannerModelOverride });
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

  const onClearError = () => setErrorMessage(null);
  const appContextValue: AppContextValue = {
    config,
    reloadConfig,
    commands,
    errorMessage,
    onClearError,
    projectDir,
    availableSkills: skills.available,
    selectedSkillIds: skills.selected,
    onSkillsConfirm: skills.setSelected,
    selectedSkillMetas: skills.selectedMetas,
  };

  return (
    <ThemeProvider theme={theme}>
    <AppContext.Provider value={appContextValue}>
      <Router
        screen={screen}
        routeData={routeData}
        overlayActive={overlay.active}
        exclusiveInput={overlay.exclusiveInput}
        onCloseOverlay={overlay.close}
        onOpenOverlay={overlay.open}
        onSetExclusive={overlay.setExclusive}
        sessions={sessions}
        paletteItems={paletteItems}
        onSlashCommand={handleSlashCommand}
        navigate={navigate}
      />
    </AppContext.Provider>
    </ThemeProvider>
  );
}
