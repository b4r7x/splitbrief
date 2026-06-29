import type { ReactNode } from 'react';
import { useRef } from 'react';
import { useApp, useInput } from 'ink';
import { isConfiguredKeyDebugEnabled, logDiptychParsedKey } from './core/key-debug.js';
import { createRuntimeCommands } from './core/runtime/commands/registry.js';
import { buildCommandContext } from './app/command-context.js';
import { executeRuntimeCommand } from './core/runtime/commands/dispatch.js';
import { useAppKeys } from './app/keys.js';
import { Layout } from './layout.js';
import { ThemeProvider, resolveTheme } from './components/theme.js';
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
import {
  CommandPaletteOverlay,
  type CommandPaletteOverlayProps,
} from './features/palette/overlay.js';
import { SkillsPicker } from './features/skills/picker.js';
import { SessionsPicker } from './features/sessions/picker.js';
import { SettingsOverlay } from './features/settings/overlay.js';
import { ModeSelector } from './features/settings/mode-selector.js';
import { ToolModelPicker } from './features/runners/picker.js';
import {
  interruptTurn,
  requestCancel,
  requestRewind,
  requestClearQueue,
} from './features/workflow/handlers.js';
import { findLatestExpandableActivityBatchKey } from './features/workflow/conversation-rows/activity-batch-key.js';
import { readConversationScrollSnapshot } from './features/workflow/layout/snapshot.js';
import { focusHasResolvableCopy, resolveCopyValue } from './features/workflow/copy/resolve.js';
import { getSections } from './stores/workflow/actions.js';
import { CostDrilldownOverlay } from './features/workflow/components/cost/drilldown-overlay.js';
import { useMouseScroll } from './features/workflow/hooks/use-mouse-scroll.js';
import { usePointer } from './features/workflow/hooks/use-mouse-pointer.js';
import type { RuntimeCommandDef, CopyResult, CopyTarget } from './core/runtime/commands/types.js';
import type { OverlayType, Screen } from './core/navigation/types.js';
import { assertNever } from './utils/type-guards.js';

export function App() {
  const [{ screen }, { active: overlayActive }, { phase }] = useStores(
    routerStore,
    overlayStore,
    lifecycleStore,
  );
  const { exit } = useApp();
  const config = configStore.useConfig();
  const theme = resolveTheme(config.theme);

  const ctx = buildCommandContext({
    exit,
    workflow: {
      requestRewind,
      requestClearQueue,
      findLatestActivityBatchKey: () => findLatestExpandableActivityBatchKey(getSections()),
      readScrollMetrics: readConversationScrollSnapshot,
      resolveCopyValue,
    },
  });
  const commands = createRuntimeCommands(ctx);
  const runtimeChainRef = useRef(Promise.resolve());
  const handleRuntimeCommand = (raw: string, from: Screen) => {
    runtimeChainRef.current = runtimeChainRef.current
      .then(() =>
        executeRuntimeCommand(commands, raw, {
          screen: from,
          phase,
          onError: feedbackStore.setError,
        }),
      )
      .catch(() => {});
  };

  useAppKeys({
    exit,
    interruptWorkflow: interruptTurn,
    cancelWorkflow: requestCancel,
  });
  useMouseScroll();
  usePointer();
  useInput((input, key) => logDiptychParsedKey(input, key), {
    isActive: isConfiguredKeyDebugEnabled(),
  });

  return (
    <ThemeProvider theme={theme}>
      <Layout
        screen={renderScreen({
          screen,
          commands,
          onRuntime: handleRuntimeCommand,
          copyTarget: ctx.copyTarget,
        })}
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

function renderScreen({
  screen,
  commands,
  onRuntime,
  copyTarget,
}: {
  screen: Screen;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string, from: Screen) => void;
  copyTarget: (target: CopyTarget) => Promise<CopyResult>;
}): ReactNode {
  switch (screen) {
    case 'home':
      return <HomeScreen commands={commands} onRuntimeCommand={(raw) => onRuntime(raw, 'home')} />;
    case 'workflow':
      return (
        <WorkflowScreen
          commands={commands}
          onRuntimeCommand={(raw) => onRuntime(raw, 'workflow')}
          copyTarget={copyTarget}
          canCopyFocused={focusHasResolvableCopy}
        />
      );
    case 'summary':
      return (
        <SummaryScreen commands={commands} onRuntimeCommand={(raw) => onRuntime(raw, 'summary')} />
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

function renderOverlay({
  active,
  screen,
  commands,
  onRuntime,
  onWorkflowMode,
}: {
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
    default:
      return assertNever(active);
  }
}
