import { WORKFLOW_MODES } from '../../core/schemas/enums.js';
import type { Config } from '../../core/schemas/config.js';
import type { Phase, WorkflowMode } from '../../core/schemas/enums.js';
import type { Session } from '../../core/schemas/session.js';
import type { Screen } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { routerStore } from '../../stores/navigation/router.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import type { WorkflowTask } from '../../stores/workflow/tasks.js';
import type { PaletteInputs } from './results.js';

type PaletteSources = Omit<PaletteInputs, 'query' | 'mruIds'>;

interface BuildPaletteSourcesOptions {
  commands: RuntimeCommandDef[];
  screen: Screen;
  config: Config;
  phase: Phase;
  tasks: WorkflowTask[];
  sessions: Session[];
  onRuntimeCommand: (raw: string) => unknown;
  onWorkflowMode: (mode: WorkflowMode) => unknown;
}

export function buildPaletteSources({
  commands,
  screen,
  config,
  phase,
  tasks,
  sessions,
  onRuntimeCommand,
  onWorkflowMode,
}: BuildPaletteSourcesOptions): PaletteSources {
  return {
    commandItems: buildCommandItems(commands, screen, onRuntimeCommand),
    modeItems: buildModeItems(onWorkflowMode),
    pickerItems: buildPickerItems(),
    taskItems: buildTaskItems(tasks, phase),
    sessionItems: buildSessionItems(sessions),
    customItems: buildCustomItems(config, onRuntimeCommand),
  };
}

function buildCommandItems(
  commands: RuntimeCommandDef[],
  screen: Screen,
  onRuntimeCommand: (raw: string) => unknown,
): PaletteSources['commandItems'] {
  return commands
    .filter((cmd): cmd is RuntimeCommandDef & { label: string } => !!cmd.label)
    .map(cmd => ({
      label: cmd.label,
      description: cmd.description,
      shortcut: cmd.shortcut ?? null,
      action: () => { void onRuntimeCommand(cmd.name); },
      availableOn: cmd.validScreens,
    }))
    .filter(item => item.availableOn.includes(screen));
}

function buildModeItems(onWorkflowMode: (mode: WorkflowMode) => unknown): PaletteSources['modeItems'] {
  return WORKFLOW_MODES.map(mode => ({
    label: mode,
    description: `Switch to ${mode} mode`,
    action: () => { void onWorkflowMode(mode); },
  }));
}

function buildPickerItems(): PaletteSources['pickerItems'] {
  return [
    {
      label: 'Planner',
      description: 'Select planner tool',
      action: () => { overlayStore.open('planner-picker'); },
    },
    {
      label: 'Implementer',
      description: 'Select implementer',
      action: () => { overlayStore.open('implementer-picker'); },
    },
    {
      label: 'Sessions',
      description: 'Browse past sessions',
      action: () => { overlayStore.open('sessions'); },
    },
    {
      label: 'Settings',
      description: 'Planner, model & settings',
      action: () => { overlayStore.open('settings'); },
    },
  ];
}

function buildTaskItems(tasks: WorkflowTask[], phase: Phase): PaletteSources['taskItems'] {
  if (phase !== 'implementing' && phase !== 'validating-task' && phase !== 'escalating') {
    return [];
  }

  return tasks.map(t => ({
    id: t.id,
    title: t.title,
    action: () => { feedbackStore.setMessage(`Task ${t.id}: ${t.title}`); },
  }));
}

function buildSessionItems(sessions: Session[]): PaletteSources['sessionItems'] {
  return sessions.slice(0, 10).map(s => ({
    id: s.id,
    feature: s.feature,
    status: s.status,
    action: () => {
      if (s.status === 'interrupted') {
        routerStore.navigate({ to: 'workflow', feature: s.feature });
        return;
      }
      if (s.summary) {
        routerStore.navigate({ to: 'summary', summary: s.summary, sessionId: s.id });
        return;
      }
      feedbackStore.setMessage(`Session "${s.feature}" failed without a summary to display`);
    },
  }));
}

function buildCustomItems(
  config: Config,
  onRuntimeCommand: (raw: string) => unknown,
): PaletteSources['customItems'] {
  return (config.palette?.customActions ?? []).map(a => ({
    id: a.id,
    label: a.label,
    description: a.description ?? '',
    action: () => { void onRuntimeCommand(a.command); },
  }));
}
