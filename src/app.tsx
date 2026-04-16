import type { ReactNode } from 'react';
import { useApp } from 'ink';
import { createCommands, toPaletteItems, executeSlashCommand } from './core/commands/index.js';
import { useGlobalKeys } from './hooks/use-global-keys.js';
import { Layout } from './layout.js';
import { ThemeProvider, getTheme } from './ui/theme.js';
import { routerStore } from './stores/router.js';
import { configStore } from './stores/config.js';
import { overlayStore } from './stores/overlay.js';
import { feedbackStore } from './stores/feedback.js';
import { workflowStore } from './stores/workflow.js';
import { useStores } from './stores/use-stores.js';
import { refreshDetection } from './engine/detection/index.js';
import { HomeScreen } from './screens/home.js';
import { WorkflowScreen } from './screens/workflow.js';
import { SummaryScreen } from './screens/summary.js';
import { SetupScreen } from './screens/setup.js';
import { HelpOverlay } from './components/overlays/help-overlay.js';
import { CommandPalette } from './components/overlays/command-palette.js';
import { SkillsPicker } from './components/overlays/skills-picker/skills-picker.js';
import { SessionsPicker } from './components/overlays/sessions-picker/sessions-picker.js';
import { SettingsOverlay } from './components/overlays/settings-overlay/settings-overlay.js';
import { ModeSelector } from './components/overlays/mode-selector.js';
import { ToolModelPicker } from './components/overlays/tool-model-picker/picker.js';
import type { Screen, OverlayType, SlashCommandDef, CommandContext, CommandPaletteItem } from './types.js';

export function App() {
  const [{ screen }, { active: overlayActive }] = useStores(routerStore, overlayStore);
  const { exit } = useApp();
  const config = configStore.useConfig();
  const theme = getTheme(config.theme);

  const ctx: CommandContext = {
    openOverlay: overlayStore.open,
    navigate: routerStore.navigate,
    quit: exit,
    setWorkflowMode: (mode) => {
      const current = configStore.get().config;
      if (!current) return false;
      return configStore.save({ ...current, workflow: { ...current.workflow, mode } });
    },
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      const projectDir = configStore.get().projectDir;
      await refreshDetection(projectDir);
    },
    getCurrentPhase: () => workflowStore.get().phase,
    requestRewind: (target, comment) => {
      const base = { target } as const;
      return workflowStore.requestRewind(comment ? { ...base, comment } : base);
    },
    requestTaskRedo: (taskId) =>
      workflowStore.requestRewind({ target: 'task', taskId }),
    getQueueDepth: () => workflowStore.get().queueDepth,
    clearQueue: () => workflowStore.requestClearQueue(),
  };
  const commands = createCommands(ctx);
  const paletteItems = toPaletteItems(commands);
  const handleSlashCommand = (raw: string, from: Screen) =>
    executeSlashCommand(commands, raw, from, feedbackStore.setError);

  useGlobalKeys({ exit });

  return (
    <ThemeProvider theme={theme}>
      <Layout
        screen={renderScreen({ screen, commands, onSlash: handleSlashCommand })}
        overlay={renderOverlay({ active: overlayActive, screen, commands, paletteItems })}
      />
    </ThemeProvider>
  );
}

function renderScreen({ screen, commands, onSlash }: {
  screen: Screen;
  commands: SlashCommandDef[];
  onSlash: (raw: string, from: Screen) => void;
}): ReactNode {
  switch (screen) {
    case 'home':
      return (
        <HomeScreen
          commands={commands}
          onSlashCommand={(raw) => onSlash(raw, 'home')}
        />
      );
    case 'workflow':
      return (
        <WorkflowScreen
          commands={commands}
          onSlashCommand={(raw) => onSlash(raw, 'workflow')}
        />
      );
    case 'summary':
      return (
        <SummaryScreen
          commands={commands}
          onSlashCommand={(raw) => onSlash(raw, 'summary')}
        />
      );
    case 'setup':
      return <SetupScreen />;
    default: {
      screen satisfies never;
      return null;
    }
  }
}

function renderOverlay({ active, screen, commands, paletteItems }: {
  active: OverlayType;
  screen: Screen;
  commands: SlashCommandDef[];
  paletteItems: CommandPaletteItem[];
}): ReactNode | null {
  switch (active) {
    case 'none':
      return null;
    case 'help':
      return <HelpOverlay currentScreen={screen} commands={commands} />;
    case 'command-palette':
      return <CommandPalette items={paletteItems} currentScreen={screen} />;
    case 'skills':
      return <SkillsPicker />;
    case 'settings':
      return <SettingsOverlay />;
    case 'mode-selector':
      return <ModeSelector />;
    case 'planner-picker':
      return <ToolModelPicker role="planner" />;
    case 'implementer-picker':
      return <ToolModelPicker role="implementer" />;
    case 'sessions':
      return <SessionsPicker />;
    default: {
      active satisfies never;
      return null;
    }
  }
}
