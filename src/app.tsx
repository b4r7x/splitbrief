import type { ReactNode } from 'react';
import { useApp } from 'ink';
import { createRuntimeCommands } from './core/runtime/commands/registry.js';
import { buildCommandContext } from './app/command-context.js';
import { executeRuntimeCommand } from './core/runtime/commands/dispatch.js';
import { useAppKeys } from './app/keys.js';
import { abortTurn } from './features/workflow/handlers.js';
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
import { HelpOverlay } from './features/help/overlay.js';
import { CommandPaletteOverlay, type CommandPaletteOverlayProps } from './features/palette/overlay.js';
import { SkillsPicker } from './features/skills/picker.js';
import { SessionsPicker } from './features/sessions/picker.js';
import { SettingsOverlay } from './features/settings/overlay.js';
import { ModeSelector } from './features/settings/mode-selector.js';
import { ToolModelPicker } from './features/runners/picker.js';
import { CostDrilldownOverlay } from './features/workflow/components/cost/drilldown-overlay.js';
import { PlanEditorHelpOverlay } from './features/workflow/components/plan-editor/help-overlay.js';
import type { RuntimeCommandDef } from './core/runtime/commands/types.js';
import type { OverlayType, Screen } from './stores/navigation/router.js';
import { assertNever } from './utils/type-guards.js';

export function App() {
  const [{ screen }, { active: overlayActive }, { phase }] = useStores(routerStore, overlayStore, lifecycleStore);
  const { exit } = useApp();
  const config = configStore.useConfig();
  const theme = getTheme(config.theme);

  const ctx = buildCommandContext({ exit });
  const commands = createRuntimeCommands(ctx);
  const handleRuntimeCommand = (raw: string, from: Screen) => {
    void executeRuntimeCommand(commands, raw, { screen: from, phase, onError: feedbackStore.setError });
  };

  useAppKeys({ exit, abortWorkflow: abortTurn });
  useMouseScroll();

  return (
    <ThemeProvider theme={theme}>
      <Layout
        screen={renderScreen({ screen, commands, onRuntime: handleRuntimeCommand })}
        overlay={renderOverlay({
          active: overlayActive,
          screen,
          commands,
          onRuntime: (raw) => handleRuntimeCommand(raw, screen),
          onWorkflowMode: ctx.setWorkflowMode,
        })}
      />
    </ThemeProvider>
  );
}

function renderScreen({ screen, commands, onRuntime }: {
  screen: Screen;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string, from: Screen) => void;
}): ReactNode {
  switch (screen) {
    case 'home':
      return (
        <HomeScreen
          commands={commands}
          onRuntimeCommand={(raw) => onRuntime(raw, 'home')}
        />
      );
    case 'workflow':
      return (
        <WorkflowScreen
          commands={commands}
          onRuntimeCommand={(raw) => onRuntime(raw, 'workflow')}
        />
      );
    case 'summary':
      return (
        <SummaryScreen
          commands={commands}
          onRuntimeCommand={(raw) => onRuntime(raw, 'summary')}
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

function renderOverlay({ active, screen, commands, onRuntime, onWorkflowMode }: {
  active: OverlayType;
  screen: Screen;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string) => void;
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
          onRuntimeCommand={onRuntime}
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
