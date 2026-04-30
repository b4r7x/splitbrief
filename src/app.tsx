import type { ReactNode } from 'react';
import { useApp } from 'ink';
import { createCommands } from './core/slash-commands/catalog.js';
import { buildCommandContext } from './app/slash-command-context.js';
import { executeSlashCommand } from './core/slash-commands/dispatch.js';
import { useAppKeys } from './hooks/use-app-keys.js';
import { useMouseScroll } from './features/workflow/hooks/use-mouse-scroll.js';
import { Layout } from './layout.js';
import { ThemeProvider, getTheme } from './components/theme.js';
import { routerStore } from './stores/navigation/router.js';
import { configStore } from './stores/project/config.js';
import { overlayStore } from './stores/ui/overlay.js';
import { feedbackStore } from './stores/ui/feedback.js';
import { lifecycleStore } from './stores/workflow/lifecycle.js';
import { useStores } from './stores/use-stores.js';
import { HomeScreen } from './features/home/screen.js';
import { WorkflowScreen } from './features/workflow/screen.js';
import { SummaryScreen } from './features/summary/screen.js';
import { SetupScreen } from './features/setup/screen.js';
import { HelpOverlay } from './components/overlays/help-overlay.js';
import { CommandPaletteOverlay, type CommandPaletteOverlayProps } from './features/workflow/components/command-palette-overlay.js';
import { SkillsPicker } from './features/skills/picker.js';
import { SessionsPicker } from './features/sessions/picker.js';
import { SettingsOverlay } from './features/settings/overlay.js';
import { ModeSelector } from './features/settings/mode-selector.js';
import { ToolModelPicker } from './features/tool-picker/picker.js';
import { CostDrilldownOverlay } from './features/workflow/components/cost-drilldown-overlay.js';
import { PlanEditorHelpOverlay } from './features/workflow/components/plan-editor-help-overlay.js';
import type { SlashCommandDef } from './core/slash-commands/types.js';
import type { OverlayType, Screen } from './stores/navigation/router.js';
import { assertNever } from './utils/type-guards.js';

export function App() {
  const [{ screen }, { active: overlayActive }, { phase }] = useStores(routerStore, overlayStore, lifecycleStore);
  const { exit } = useApp();
  const config = configStore.useConfig();
  const theme = getTheme(config.theme);

  const ctx = buildCommandContext({ exit });
  const commands = createCommands(ctx);
  const handleSlashCommand = (raw: string, from: Screen) => {
    void executeSlashCommand(commands, raw, { screen: from, phase, onError: feedbackStore.setError });
  };

  useAppKeys({ exit });
  useMouseScroll();

  return (
    <ThemeProvider theme={theme}>
      <Layout
        screen={renderScreen({ screen, commands, onSlash: handleSlashCommand })}
        overlay={renderOverlay({
          active: overlayActive,
          screen,
          commands,
          onSlash: (raw) => handleSlashCommand(raw, screen),
          onWorkflowMode: ctx.setWorkflowMode,
        })}
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
      return (
        <SetupScreen
          renderToolPicker={({ role, stepLabel, onConfirm, onCancel }) => (
            <ToolModelPicker
              role={role}
              stepLabel={stepLabel}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          )}
        />
      );
    default:
      return assertNever(screen);
  }
}

function renderOverlay({ active, screen, commands, onSlash, onWorkflowMode }: {
  active: OverlayType;
  screen: Screen;
  commands: SlashCommandDef[];
  onSlash: (raw: string) => void;
  onWorkflowMode: CommandPaletteOverlayProps['onWorkflowMode'];
}): ReactNode | null {
  switch (active) {
    case 'none':
      return null;
    case 'help':
      return <HelpOverlay currentScreen={screen} commands={commands} />;
    case 'command-palette':
      return (
        <CommandPaletteOverlay
          commands={commands}
          onSlashCommand={onSlash}
          onWorkflowMode={onWorkflowMode}
        />
      );
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
    case 'cost-drilldown':
      return <CostDrilldownOverlay />;
    case 'plan-editor-help':
      return <PlanEditorHelpOverlay />;
    default:
      return assertNever(active);
  }
}
