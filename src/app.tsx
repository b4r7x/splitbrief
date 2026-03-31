import React, { useState, useCallback, useMemo } from 'react';
import { useInput, useApp } from 'ink';
import { useRouter } from './hooks/use-router.js';
import { useSessions } from './hooks/use-sessions.js';
import { useOverlay } from './hooks/use-overlay.js';
import { HomeScreen } from './ui/screens/home.js';
import { WorkflowScreen } from './ui/screens/workflow.js';
import { SummaryScreen } from './ui/screens/summary.js';
import { HelpOverlay } from './ui/help-overlay.js';
import { CommandPalette } from './ui/command-palette.js';
import { loadConfig } from './config.js';
import { getTheme } from './theme.js';
import { createCommands, findCommand, getCommandsForScreen } from './commands.js';
import type { WorkflowState, RouteData, Screen, OverlayType, CommandPaletteItem } from './types.js';

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

  const config = loadConfig(projectDir);
  if (modelOverride) config.implementer.model = modelOverride;
  if (providerOverride) config.implementer.provider = providerOverride;
  if (contextLengthOverride) config.implementer.contextLength = contextLengthOverride;
  if (plannerOverride) (config.planner as any).tool = plannerOverride;
  if (plannerModelOverride) (config.planner as any).model = plannerModelOverride;

  const theme = getTheme(config.theme);
  const sessionsScope = config.sessions?.scope ?? 'project';
  const { sessions } = useSessions(sessionsScope, projectDir);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const clearError = useCallback(() => setErrorMessage(null), []);

  const commands = useMemo(() => createCommands({
    openOverlay: overlay.open,
    closeOverlay: overlay.close,
    toggleSidebar: () => {},
    showStatus: () => {
      setErrorMessage('No active workflow');
    },
    quit: () => exit(),
  }), [overlay.open, overlay.close, exit]);

  const handleSlashCommand = useCallback((raw: string, fromScreen: Screen) => {
    const name = raw.split(' ')[0].toLowerCase();
    const cmd = findCommand(commands, name);

    if (!cmd) {
      setErrorMessage(`Unknown command: ${name}. Type /help for available commands.`);
      return;
    }

    if (!cmd.validScreens.includes(fromScreen)) {
      setErrorMessage(`${cmd.name} is only available on the ${cmd.validScreens.join(', ')} screen.`);
      return;
    }

    cmd.handler({ openOverlay: overlay.open, closeOverlay: overlay.close, toggleSidebar: () => {}, showStatus: () => setErrorMessage('No active workflow'), quit: () => exit() });
  }, [commands, overlay.open, overlay.close, exit]);

  useInput((input, key) => {
    if (key.escape && overlay.isOpen) {
      overlay.close();
      return;
    }
    if (key.ctrl && input === 'k' && !overlay.isOpen) {
      overlay.open('command-palette');
    }
  });

  const paletteItems: CommandPaletteItem[] = useMemo(() => {
    const allScreens: Screen[] = ['home', 'workflow', 'summary'];
    const items: CommandPaletteItem[] = [
      { label: 'Help', description: 'Show commands and shortcuts', shortcut: '?', action: () => overlay.open('help'), availableOn: allScreens },
      { label: 'Status', description: 'Show workflow progress', shortcut: null, action: () => setErrorMessage('No active workflow'), availableOn: allScreens },
      { label: 'Configure', description: 'Select planner and model', shortcut: null, action: () => overlay.open('picker'), availableOn: ['home'] },
      { label: 'Toggle Sidebar', description: 'Show/hide task sidebar', shortcut: 'Ctrl+\\', action: () => {}, availableOn: ['workflow'] },
      { label: 'Toggle Diff', description: 'Expand/collapse latest diff', shortcut: 'd', action: () => {}, availableOn: ['workflow'] },
      { label: 'Quit', description: 'Exit tiny-spec', shortcut: 'q', action: () => exit(), availableOn: allScreens },
    ];
    return items;
  }, [overlay.open, exit]);

  if (overlay.active === 'help') {
    return <HelpOverlay onClose={overlay.close} theme={theme} />;
  }

  if (overlay.active === 'command-palette') {
    return (
      <CommandPalette
        items={paletteItems}
        currentScreen={screen}
        onExecute={(item) => { overlay.close(); item.action(); }}
        onClose={overlay.close}
        theme={theme}
      />
    );
  }

  if (screen === 'home') {
    return (
      <HomeScreen
        config={config}
        sessions={sessions}
        onStartWorkflow={(feat) => navigate('workflow', { feature: feat })}
        onSlashCommand={(raw) => handleSlashCommand(raw, 'home')}
        onOpenOverlay={overlay.open}
        errorMessage={errorMessage}
        onClearError={clearError}
        theme={theme}
      />
    );
  }

  if (screen === 'summary' && routeData.screen === 'summary') {
    return (
      <SummaryScreen
        summary={routeData.summary}
        theme={theme}
        onDone={() => navigate('home')}
        onSlashCommand={(raw) => handleSlashCommand(raw, 'summary')}
        onOpenOverlay={overlay.open}
        errorMessage={errorMessage}
        onClearError={clearError}
      />
    );
  }

  if (screen === 'workflow' && routeData.screen === 'workflow') {
    return (
      <WorkflowScreen
        feature={routeData.feature}
        config={config}
        theme={theme}
        auto={auto}
        projectDir={projectDir}
        resumeState={routeData.resumeState}
        onComplete={(summary) => navigate('summary', { summary })}
        onSlashCommand={(raw) => handleSlashCommand(raw, 'workflow')}
        onOpenOverlay={overlay.open}
        errorMessage={errorMessage}
        onClearError={clearError}
      />
    );
  }

  return null;
}
