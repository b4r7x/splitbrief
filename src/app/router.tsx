import type { ReactNode } from 'react';
import { Layout } from './layout.js';
import { HomeScreen } from './screens/home.js';
import { WorkflowScreen } from './screens/workflow.js';
import { SetupScreen } from './screens/setup.js';
import { HelpOverlay } from './overlays/help.js';
import { CommandPaletteOverlay } from './overlays/palette.js';
import { SkillsPicker } from './overlays/skills.js';
import { SessionsPicker } from './overlays/sessions.js';
import { EditorOverlay } from './overlays/editor.js';
import { SettingsOverlay } from './overlays/settings.js';
import { UsageOverlay } from './overlays/usage.js';
import { ToolModelPicker } from './overlays/runners.js';
import type { RuntimeCommandDef } from '../core/runtime/commands/types.js';
import type { OverlayType, Screen } from '../core/navigation/types.js';
import type { WorkflowScreenDeps } from '../features/workflow/hooks/workflow-screen/use-model.js';
import type { AppInteractionDeps } from './root.js';
import { assertNever } from '../utils/type-guards.js';
import { SessionPreparation, useSessionPreparationTakesPage } from './session-preparation.js';

interface RouterProps {
  screen: Screen;
  overlayActive: OverlayType;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string, from: Screen) => void;
  workflowDeps?: WorkflowScreenDeps | undefined;
  interactionDeps?: AppInteractionDeps | undefined;
}

export function Router({
  screen,
  overlayActive,
  commands,
  onRuntime,
  workflowDeps,
  interactionDeps,
}: RouterProps) {
  const sessionPreparationTakesPage = useSessionPreparationTakesPage();

  return (
    <Layout
      sessionPreparation={<SessionPreparation />}
      sessionPreparationTakesPage={sessionPreparationTakesPage}
      screen={renderScreen({
        screen,
        commands,
        onRuntime,
        workflowDeps,
        interactionDeps,
      })}
      overlay={renderOverlay({
        active: overlayActive,
        screen,
        commands,
        onRuntime: (raw) => onRuntime(raw, screen),
        interactionDeps,
      })}
    />
  );
}

function renderScreen({
  screen,
  commands,
  onRuntime,
  workflowDeps,
  interactionDeps,
}: {
  screen: Screen;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string, from: Screen) => void;
  workflowDeps?: WorkflowScreenDeps | undefined;
  interactionDeps?: AppInteractionDeps | undefined;
}): ReactNode {
  switch (screen) {
    case 'home':
      return (
        <HomeScreen
          commands={commands}
          onRuntimeCommand={(raw) => onRuntime(raw, 'home')}
          deps={interactionDeps?.home}
          readClipboardImage={interactionDeps?.readClipboardImage}
          listProjectFiles={interactionDeps?.listProjectFiles}
        />
      );
    case 'workflow':
      return (
        <WorkflowScreen
          commands={commands}
          onRuntimeCommand={(raw) => onRuntime(raw, 'workflow')}
          deps={workflowDeps}
          readClipboardImage={interactionDeps?.readClipboardImage}
          listProjectFiles={interactionDeps?.listProjectFiles}
        />
      );
    case 'setup':
      return <SetupScreen deps={interactionDeps?.setup} />;
    default:
      return assertNever(screen);
  }
}

function renderOverlay({
  active,
  screen,
  commands,
  onRuntime,
  interactionDeps,
}: {
  active: OverlayType;
  screen: Screen;
  commands: RuntimeCommandDef[];
  onRuntime: (raw: string) => void;
  interactionDeps?: AppInteractionDeps | undefined;
}): ReactNode | null {
  switch (active) {
    case 'none':
      return null;
    case 'help':
      return <HelpOverlay currentScreen={screen} commands={commands} />;
    case 'command-palette':
      return <CommandPaletteOverlay commands={commands} onRuntimeCommand={onRuntime} />;
    case 'skills':
      return <SkillsPicker />;
    case 'settings':
      return <SettingsOverlay />;
    case 'planner-picker':
      return <ToolModelPicker role="planner" deps={interactionDeps?.picker} />;
    case 'implementer-picker':
      return <ToolModelPicker role="implementer" deps={interactionDeps?.picker} />;
    case 'reviewer-picker':
      return <ToolModelPicker role="reviewer" deps={interactionDeps?.picker} />;
    case 'stop-sheet':
      // This focus owner is rendered above the workflow composer, without covering the page.
      return null;
    case 'sessions':
      // `SessionsPicker.deps` is required-when-present, so an absent interaction object
      // passes no prop at all rather than an explicit `undefined`.
      return (
        <SessionsPicker
          {...(interactionDeps === undefined ? {} : { deps: interactionDeps.home.sessionSelect })}
        />
      );
    case 'usage-details':
      return <UsageOverlay />;
    case 'editor':
      return <EditorOverlay />;
    default:
      return assertNever(active);
  }
}
