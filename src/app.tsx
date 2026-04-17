import type { ReactNode } from 'react';
import { useApp } from 'ink';
import { createCommands, toPaletteItems, executeSlashCommand } from './core/slash-commands/index.js';
import { useAppKeys } from './hooks/use-app-keys.js';
import { useMouseScroll } from './features/workflow/hooks/use-mouse-scroll.js';
import { Layout } from './layout.js';
import { ThemeProvider, getTheme } from './components/theme.js';
import { routerStore } from './stores/navigation/router.js';
import { configStore } from './stores/project/config.js';
import { overlayStore } from './stores/ui/overlay.js';
import { feedbackStore } from './stores/ui/feedback.js';
import { lifecycleStore } from './stores/workflow/lifecycle.js';
import { requestRewind, requestClearQueue } from './features/workflow/handlers.js';
import { useStores } from './stores/use-stores.js';
import { refreshDetection } from './engine/detection/index.js';
import { HomeScreen } from './features/home/screen.js';
import { WorkflowScreen } from './features/workflow/screen.js';
import { SummaryScreen } from './features/summary/screen.js';
import { SetupScreen } from './features/setup/screen.js';
import { HelpOverlay } from './components/overlays/help-overlay.js';
import { CommandPalette } from './components/overlays/command-palette.js';
import { SkillsPicker } from './features/skills/picker.js';
import { SessionsPicker } from './features/sessions/picker.js';
import { SettingsOverlay } from './features/settings/overlay.js';
import { ModeSelector } from './components/overlays/mode-selector.js';
import { ToolModelPicker } from './features/tool-picker/picker.js';
import type { Screen, OverlayType, SlashCommandDef, CommandContext, CommandPaletteItem } from './types.js';
import { assertNever } from './utils/type-guards.js';

export function App() {
  const [{ screen }, { active: overlayActive }] = useStores(routerStore, overlayStore);
  const { exit } = useApp();
  const config = configStore.useConfig();
  const theme = getTheme(config.theme);

  const ctx: CommandContext = {
    openOverlay: overlayStore.open,
    navigate: (to) => routerStore.navigate({ to }),
    quit: exit,
    setWorkflowMode: (mode) => {
      const current = configStore.get().config;
      if (!current) return false;
      const result = configStore.save({ ...current, workflow: { ...current.workflow, mode } });
      if (!result.ok && result.error) {
        feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      }
      return result.ok;
    },
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {
      const projectDir = configStore.get().projectDir;
      await refreshDetection(projectDir);
    },
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestRewind: (target, comment) => {
      const base = { target } as const;
      return requestRewind(comment ? { ...base, comment } : base);
    },
    requestTaskRedo: (taskId) =>
      requestRewind({ target: 'task', taskId }),
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: () => requestClearQueue(),
  };
  const commands = createCommands(ctx);
  const paletteItems = toPaletteItems(commands);
  const handleSlashCommand = (raw: string, from: Screen) =>
    executeSlashCommand(commands, raw, from, feedbackStore.setError);

  useAppKeys({ exit });
  useMouseScroll();

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
    default:
      return assertNever(screen);
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
    default:
      return assertNever(active);
  }
}
