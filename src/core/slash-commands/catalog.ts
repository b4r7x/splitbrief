import { ALL_SCREENS } from '../../stores/navigation/router.js';
import { WORKFLOW_MODES } from '../schemas/enums.js';
import type { SlashCommandDef, CommandContext } from './types.js';
import { getShortcutKey } from './keybindings.js';
import { includes } from '../../utils/type-guards.js';
import type { Phase } from '../schemas/enums.js';
import { PHASES } from '../schemas/enums.js';

export function phaseOrder(phase: Phase): number {
  return PHASES.indexOf(phase);
}

const TERMINAL: ReadonlySet<Phase> = new Set(['idle', 'complete']);

export function canReviseSpec(phase: Phase): boolean {
  return !TERMINAL.has(phase) && phaseOrder(phase) >= phaseOrder('reviewing-spec');
}

export function canRevisePlan(phase: Phase): boolean {
  return !TERMINAL.has(phase) && phaseOrder(phase) >= phaseOrder('reviewing-plan');
}

export function canRedoTask(phase: Phase): boolean {
  return phase === 'implementing' || phase === 'validating-task' || phase === 'escalating';
}

export function createCommands(ctx: CommandContext): SlashCommandDef[] {
  return [
    {
      kind: 'noarg',
      name: '/help',
      label: 'Help',
      description: 'Show help overlay',
      shortcut: getShortcutKey('help'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('help'),
    },
    {
      kind: 'noarg',
      name: '/palette',
      label: 'Palette',
      description: 'Open command palette',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('command-palette'),
    },
    {
      kind: 'noarg',
      name: '/skills',
      label: 'Skills',
      description: 'Select planner skills',
      shortcut: getShortcutKey('skills'),
      validScreens: ['home'],
      handler: () => ctx.openOverlay('skills'),
    },
    {
      kind: 'noarg',
      name: '/sessions',
      label: 'Sessions',
      description: 'Browse past sessions',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('sessions'),
    },
    {
      kind: 'noarg',
      name: '/settings',
      aliases: ['/config'],
      label: 'Settings',
      description: 'Planner, model & settings',
      shortcut: getShortcutKey('settings'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('settings'),
    },
    {
      kind: 'arg',
      name: '/mode',
      label: 'Mode',
      description: 'Select workflow mode \u2192',
      validScreens: ALL_SCREENS,
      handler: (args) => {
        if (!args) {
          ctx.openOverlay('mode-selector');
          return;
        }
        const mode = args.trim().toLowerCase();
        if (!includes(WORKFLOW_MODES, mode)) {
          ctx.setFeedbackError(`Invalid mode: ${mode}. Valid modes: ${WORKFLOW_MODES.join(', ')}`);
          return;
        }
        if (ctx.setWorkflowMode(mode)) {
          ctx.setFeedbackMessage(`Workflow mode set to: ${mode}`);
        }
      },
    },
    {
      kind: 'noarg',
      name: '/planner',
      label: 'Planner',
      description: 'Select planner tool',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('planner-picker'),
    },
    {
      kind: 'noarg',
      name: '/implementer',
      label: 'Implementer',
      description: 'Select implementer',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('implementer-picker'),
    },
    {
      kind: 'noarg',
      name: '/home',
      label: 'Home',
      description: 'Return to home screen',
      validScreens: ['workflow', 'summary'],
      handler: () => ctx.navigate('home'),
    },
    {
      kind: 'noarg',
      name: '/refresh',
      label: 'Refresh',
      description: 'Re-detect available tools',
      validScreens: ALL_SCREENS,
      handler: () => {
        ctx.setFeedbackMessage('Refreshing tool detection…');
        ctx.refreshDetection()
          .then(() => ctx.setFeedbackMessage('Tool detection refreshed'))
          .catch(() => ctx.setFeedbackError('Tool detection failed'));
      },
    },
    {
      kind: 'arg',
      name: '/revise-spec',
      label: 'Revise Spec',
      description: 'Rewind to spec phase with optional feedback',
      validScreens: ['workflow'],
      phaseGuard: canReviseSpec,
      handler: (args) => {
        const phase = ctx.getCurrentPhase();
        if (!canReviseSpec(phase)) {
          ctx.setFeedbackError('/revise-spec is only available after the spec is written.');
          return;
        }
        const comment = args?.trim() || undefined;
        if (!ctx.requestRewind('spec', comment)) {
          ctx.setFeedbackError('Cannot rewind: no active workflow.');
        }
      },
    },
    {
      kind: 'arg',
      name: '/revise-plan',
      label: 'Revise Plan',
      description: 'Rewind to plan phase with optional feedback',
      validScreens: ['workflow'],
      phaseGuard: canRevisePlan,
      handler: (args) => {
        const phase = ctx.getCurrentPhase();
        if (!canRevisePlan(phase)) {
          ctx.setFeedbackError('/revise-plan is only available after the plan is written.');
          return;
        }
        const comment = args?.trim() || undefined;
        if (!ctx.requestRewind('plan', comment)) {
          ctx.setFeedbackError('Cannot rewind: no active workflow.');
        }
      },
    },
    {
      kind: 'arg',
      name: '/redo-task',
      label: 'Redo Task',
      description: 'Reset a task to pending and re-run it',
      validScreens: ['workflow'],
      phaseGuard: canRedoTask,
      handler: (args) => {
        const phase = ctx.getCurrentPhase();
        if (!canRedoTask(phase)) {
          ctx.setFeedbackError('/redo-task is only available during implementation.');
          return;
        }
        const id = args?.trim();
        if (!id) {
          ctx.setFeedbackError('/redo-task requires a task ID. Usage: /redo-task T001');
          return;
        }
        if (!ctx.requestTaskRedo(id)) {
          ctx.setFeedbackError('Cannot redo task: no active workflow.');
        }
      },
    },
    {
      kind: 'arg',
      name: '/queue',
      label: 'Queue',
      description: 'Show or clear the message queue',
      validScreens: ['workflow'],
      handler: (args) => {
        const sub = args?.trim().toLowerCase();
        if (!sub || sub === 'show') {
          const depth = ctx.getQueueDepth();
          if (depth === 0) {
            ctx.setFeedbackMessage('Queue is empty');
          } else {
            ctx.setFeedbackMessage(`Queue: ${depth} message${depth === 1 ? '' : 's'} pending`);
          }
          return;
        }
        if (sub === 'clear') {
          const cleared = ctx.clearQueue();
          if (cleared > 0) {
            ctx.setFeedbackMessage(`Cleared ${cleared} queued message${cleared === 1 ? '' : 's'}`);
          } else {
            ctx.setFeedbackMessage('Queue is already empty');
          }
          return;
        }
        ctx.setFeedbackError(`Unknown queue command: ${sub}. Use: /queue show or /queue clear`);
      },
    },
    {
      kind: 'arg',
      name: '/repomap',
      label: 'Repomap',
      description: 'Manage the repo-map cache',
      validScreens: ALL_SCREENS,
      handler: (args) => {
        const sub = args?.trim().toLowerCase();
        if (sub === 'rebuild') {
          ctx.rebuildRepomap()
            .then((result) => {
              if (result.deleted) {
                ctx.setFeedbackMessage('Repomap cache cleared. Next planner phase will parse from scratch.');
              } else {
                ctx.setFeedbackMessage('Repomap cache was not present.');
              }
            })
            .catch(() => ctx.setFeedbackError('Failed to clear repomap cache.'));
          return;
        }
        ctx.setFeedbackError(`Unknown repomap command: ${sub ?? ''}. Use: /repomap rebuild`);
      },
    },
    {
      kind: 'noarg',
      name: '/quit',
      label: 'Quit',
      description: 'Exit application',
      shortcut: getShortcutKey('quit'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.quit(),
    },
  ];
}
