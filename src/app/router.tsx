import type { ReactNode } from 'react';
import { Layout } from './layout.js';
import { HomeScreen } from './screens/home.js';
import { WorkflowScreen } from './screens/workflow.js';
import { SummaryScreen } from './screens/summary.js';
import { SetupScreen } from './screens/setup.js';
import { HelpOverlay } from './overlays/help.js';
import { CommandPaletteOverlay, type CommandPaletteOverlayProps } from './overlays/palette.js';
import { SkillsPicker } from './overlays/skills.js';
import { SessionsPicker } from './overlays/sessions.js';
import { EditorOverlay } from './overlays/editor.js';
import { SettingsOverlay } from './overlays/settings.js';
import { ToolModelPicker } from './overlays/runners.js';
import { ModeSelector } from '../features/settings/mode-selector.js';
import { CostDrilldownOverlay } from '../features/workflow/cost-drilldown/overlay.js';
import { focusHasResolvableCopy } from '../features/workflow/copy/resolve.js';
import type { RuntimeCommandDef, CopyResult, CopyTarget } from '../core/runtime/commands/types.js';
import type { OverlayType, Screen } from '../core/navigation/types.js';
import type { WorkflowScreenDeps } from '../features/workflow/hooks/workflow-screen/use-model.js';
import { assertNever } from '../utils/type-guards.js';
import { sessionSelectStore } from '../stores/navigation/session-select.js';
import { SessionPreparation } from './session-preparation.js';

interface RouterProps {
  screen: Screen;
  overlayActive: OverlayType;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string, from: Screen) => void;
  copyTarget: (target: CopyTarget) => Promise<CopyResult>;
  onWorkflowMode: CommandPaletteOverlayProps['onWorkflowMode'];
  workflowDeps?: WorkflowScreenDeps | undefined;
}

export function Router({
  screen,
  overlayActive,
  commands,
  onRuntime,
  copyTarget,
  onWorkflowMode,
  workflowDeps,
}: RouterProps) {
  const sessionPreparationActive = sessionSelectStore.use(
    (state) => state.preparation.kind !== 'idle',
  );

  return (
    <Layout
      sessionPreparation={<SessionPreparation />}
      sessionPreparationActive={sessionPreparationActive}
      screen={renderScreen({ screen, commands, onRuntime, copyTarget, workflowDeps })}
      overlay={renderOverlay({
        active: overlayActive,
        screen,
        commands,
        onRuntime: (raw) => onRuntime(raw, screen),
        onWorkflowMode,
      })}
    />
  );
}

function renderScreen({
  screen,
  commands,
  onRuntime,
  copyTarget,
  workflowDeps,
}: {
  screen: Screen;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string, from: Screen) => void;
  copyTarget: (target: CopyTarget) => Promise<CopyResult>;
  workflowDeps?: WorkflowScreenDeps | undefined;
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
          deps={workflowDeps}
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
    case 'editor':
      return <EditorOverlay />;
    case 'cost-drilldown':
      return <CostDrilldownOverlay />;
    default:
      return assertNever(active);
  }
}
