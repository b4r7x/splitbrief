import { WORKFLOW_MODES } from '../../core/schemas/enums.js';
import type { Config } from '../../core/schemas/config.js';
import type { Phase, WorkflowMode } from '../../core/schemas/enums.js';
import type { Session } from '../../core/schemas/session.js';
import type { Screen } from '../../core/navigation/types.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { handleSessionSelect, sessionSelectStore } from '../../stores/navigation/session-select.js';
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
  projectDir: string;
  onRuntimeCommand: (raw: string) => unknown;
  onWorkflowMode: (mode: WorkflowMode) => unknown;
  isAttached?: boolean | undefined;
}

export function buildPaletteSources({
  commands,
  screen,
  config,
  phase,
  tasks,
  sessions,
  projectDir,
  onRuntimeCommand,
  onWorkflowMode,
  isAttached = false,
}: BuildPaletteSourcesOptions): PaletteSources {
  return {
    commandItems: buildCommandItems(commands, screen, phase, onRuntimeCommand),
    modeItems: isAttached ? [] : buildModeItems(onWorkflowMode),
    pickerItems: buildPickerItems({ isAttached }),
    taskItems: buildTaskItems(tasks, phase),
    sessionItems: buildSessionItems(sessions, projectDir),
    customItems: isAttached ? [] : buildCustomItems(config, onRuntimeCommand),
  };
}

function buildCommandItems(
  commands: RuntimeCommandDef[],
  screen: Screen,
  phase: Phase,
  onRuntimeCommand: (raw: string) => unknown,
): PaletteSources['commandItems'] {
  return commands
    .filter((cmd): cmd is RuntimeCommandDef & { label: string } => !!cmd.label)
    .filter((cmd) => cmd.validScreens.includes(screen))
    .filter((cmd) => cmd.phaseGuard === undefined || cmd.phaseGuard(phase))
    .map((cmd) => ({
      label: cmd.name,
      description: cmd.description,
      shortcut: cmd.shortcut ?? null,
      action: () => {
        void onRuntimeCommand(cmd.name);
      },
      availableOn: cmd.validScreens,
    }));
}

function buildModeItems(
  onWorkflowMode: (mode: WorkflowMode) => unknown,
): PaletteSources['modeItems'] {
  return WORKFLOW_MODES.map((mode) => ({
    label: mode,
    description: `Switch to ${mode} mode`,
    action: () => {
      void onWorkflowMode(mode);
    },
  }));
}

function buildPickerItems(opts: { isAttached: boolean }): PaletteSources['pickerItems'] {
  const shared = [
    {
      label: 'sessions',
      description: 'Browse past sessions',
      action: () => {
        overlayStore.open('sessions');
      },
    },
  ];

  if (opts.isAttached) return shared;

  return [
    {
      label: 'planner',
      description: 'Select planner tool',
      action: () => {
        overlayStore.open('planner-picker');
      },
    },
    {
      label: 'implementer',
      description: 'Select implementer',
      action: () => {
        overlayStore.open('implementer-picker');
      },
    },
    ...shared,
    {
      label: 'settings',
      description: 'Planner, model & settings',
      action: () => {
        overlayStore.open('settings');
      },
    },
  ];
}

function buildTaskItems(tasks: WorkflowTask[], phase: Phase): PaletteSources['taskItems'] {
  if (phase !== 'implementing' && phase !== 'validating-task' && phase !== 'escalating') {
    return [];
  }

  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    action: () => {
      feedbackStore.setMessage(`Task ${t.id}: ${t.title}`);
    },
  }));
}

function buildSessionItems(
  sessions: Session[],
  projectDir: string,
): PaletteSources['sessionItems'] {
  return sessions.slice(0, 10).map((s) => ({
    id: s.id,
    feature: s.feature,
    status: s.status,
    action: () => {
      handleSessionSelect(s, projectDir);
      const error = sessionSelectStore.get().error;
      if (error) feedbackStore.setTransientError(error);
    },
  }));
}

function buildCustomItems(
  config: Config,
  onRuntimeCommand: (raw: string) => unknown,
): PaletteSources['customItems'] {
  return (config.palette?.customActions ?? []).map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description ?? '',
    action: () => {
      void onRuntimeCommand(a.command);
    },
  }));
}
