import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { Session } from '../../core/schemas/session.js';
import type { Screen } from '../../core/navigation/types.js';
import type { CommandGuardContext, RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { detectedModelFact, seatSupportsImages } from '../../core/runners/capabilities.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { WorkflowTask } from '../../stores/workflow/tasks.js';
import type { PaletteAction, PaletteCommandItem, PaletteInputs } from './results.js';

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
  onSessionSelect: (session: Session, projectDir: string) => Promise<void>;
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
  onSessionSelect,
}: BuildPaletteSourcesOptions): PaletteSources {
  return {
    commandItems: buildCommandItems({
      commands,
      screen,
      onRuntimeCommand,
      guardContext: {
        phase,
        plannerSupportsImages: seatSupportsImages({
          runner: config.planner,
          detected: detectedModelFact(modelCacheStore.getDetection().providers, config.planner),
        }),
      },
    }),
    taskItems: buildTaskItems(tasks, phase),
    sessionItems: buildSessionItems(sessions, projectDir, onSessionSelect),
    customItems: buildCustomItems(config, onRuntimeCommand),
  };
}

/**
 * The argument grammar is its own cell, never fused into the description: fused, the row could only
 * cut the pair, and `/copy … [m…` reads as broken syntax. An option set too large to spell out
 * carries its own hint; the row's match target still spans both.
 */
function commandHint(command: RuntimeCommandDef): string | null {
  if (command.kind !== 'arg') return null;
  return command.args.kind === 'closed'
    ? (command.args.hint ?? `[${command.args.options.join('|')}]`)
    : command.args.hint;
}

function runAction(raw: string, onRuntimeCommand: (raw: string) => unknown): PaletteAction {
  return {
    kind: 'run',
    run: () => {
      void onRuntimeCommand(raw);
    },
  };
}

export function buildCommandItems({
  commands,
  screen,
  onRuntimeCommand,
  guardContext,
}: {
  commands: RuntimeCommandDef[];
  screen: Screen;
  onRuntimeCommand: (raw: string) => unknown;
  guardContext: CommandGuardContext;
}): PaletteCommandItem[] {
  const items: PaletteCommandItem[] = [];

  for (const command of commands) {
    if (command.hidden) continue;
    if (!command.validScreens.includes(screen)) continue;
    if (command.guard?.(guardContext) !== undefined) continue;

    items.push({
      label: command.name,
      description: command.description,
      hint: commandHint(command),
      shortcut: command.shortcut ?? null,
      category: command.category,
      action:
        command.kind === 'arg'
          ? { kind: 'prefill', text: `${command.name} ` }
          : runAction(command.name, onRuntimeCommand),
    });
  }

  return items;
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
  onSessionSelect: (session: Session, projectDir: string) => Promise<void>,
): PaletteSources['sessionItems'] {
  return sessions.slice(0, 10).map((s) => ({
    id: s.id,
    feature: s.feature,
    status: s.status,
    action: async () => {
      await onSessionSelect(s, projectDir);
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
