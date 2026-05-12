import { ALL_SCREENS } from '../../navigation/types.js';
import { EFFORT_LEVELS, WORKFLOW_MODES } from '../../schemas/enums.js';
import type { RuntimeCommandDef, RuntimeCommandContext } from './types.js';
import { getShortcutKey } from '../../keybindings/registry.js';
import { includes } from '../../../utils/type-guards.js';
import type { Phase } from '../../schemas/enums.js';
import { PHASES } from '../../schemas/enums.js';
import { HANDOFF_TARGETS, parseHandoffTarget } from '../../handoff/targets.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

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

export function createRuntimeCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
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
      kind: 'arg',
      name: '/effort',
      label: 'Effort',
      description: `Set planner effort: ${EFFORT_LEVELS.join(' | ')}`,
      validScreens: ALL_SCREENS,
      handler: (args) => {
        const value = args?.trim().toLowerCase();
        if (!value) {
          ctx.setFeedbackError(`Usage: /effort <${EFFORT_LEVELS.join('|')}>`);
          return;
        }
        if (!includes(EFFORT_LEVELS, value)) {
          ctx.setFeedbackError(`Invalid effort: ${value}. Valid: ${EFFORT_LEVELS.join(', ')}`);
          return;
        }
        if (ctx.setPlannerEffort(value)) {
          ctx.setFeedbackMessage(`Planner effort set to: ${value}`);
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
      handler: async () => {
        ctx.setFeedbackMessage('Refreshing tool detection…');
        try {
          await ctx.refreshDetection();
          ctx.setFeedbackMessage('Tool detection refreshed');
        } catch {
          ctx.setFeedbackError('Tool detection failed');
        }
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
      name: '/handoff',
      label: 'Handoff',
      description: 'Export Handoff Pack for an external agent →',
      validScreens: ['workflow', 'summary'],
      handler: async (args) => {
        if (!args) {
          ctx.setFeedbackError('Usage: /handoff <target> [task-id]');
          return;
        }
        const [target, taskId] = args.trim().split(/\s+/);
        const handoffTarget = target ? parseHandoffTarget(target) : null;
        if (!target || !handoffTarget) {
          ctx.setFeedbackError(`Unknown target "${target}". Valid: ${HANDOFF_TARGETS.join(', ')}`);
          return;
        }
        try {
          const { outputDir } = await ctx.writeHandoff(handoffTarget, taskId);
          ctx.setFeedbackMessage(`Handoff written to: ${outputDir}`);
        } catch (err) {
          ctx.setFeedbackError(toErrorMessage(err));
        }
      },
    },
    {
      kind: 'noarg',
      name: '/export',
      label: 'Export',
      description: 'Export session as HTML report',
      validScreens: ['workflow', 'summary'],
      handler: async () => {
        const result = await ctx.exportSession();
        if (result.status === 'ok') {
          ctx.setFeedbackMessage(`Report written to ${result.path}`);
          return;
        }
        ctx.setFeedbackError(`Export failed: ${result.error}`);
      },
    },
    {
      kind: 'noarg',
      name: '/compact-transcript',
      label: 'Compact Transcript',
      description: 'Summarize older transcript turns',
      validScreens: ['workflow', 'summary'],
      handler: async () => {
        try {
          const result = await ctx.compactTranscript();
          if (result.status === 'unsupported') {
            ctx.setFeedbackMessage(`Planner "${result.plannerName}" does not support transcript compaction.`);
            return;
          }
          const count = result.entriesRemoved;
          const plural = count === 1 ? '' : 's';
          ctx.setFeedbackMessage(`Transcript compacted: ${count} older message${plural} summarized.`);
        } catch (err) {
          ctx.setFeedbackError(toErrorMessage(err));
        }
      },
    },
    {
      kind: 'arg',
      name: '/repomap',
      label: 'Repomap',
      description: 'Manage the repo-map cache',
      validScreens: ALL_SCREENS,
      handler: async (args) => {
        const sub = args?.trim().toLowerCase();
        if (sub === 'rebuild') {
          try {
            const result = await ctx.rebuildRepomap();
            if (result.deleted) {
              ctx.setFeedbackMessage('Repomap cache cleared. Next planner phase will parse from scratch.');
            } else {
              ctx.setFeedbackMessage('Repomap cache was not present.');
            }
          } catch {
            ctx.setFeedbackError('Failed to clear repomap cache.');
          }
          return;
        }
        ctx.setFeedbackError(`Unknown repomap command: ${sub ?? ''}. Use: /repomap rebuild`);
      },
    },
    {
      kind: 'arg',
      name: '/attach',
      label: 'Attach',
      description: 'Attach an image for the next planner call',
      validScreens: ['home', 'workflow'],
      handler: (args) => {
        const value = args?.trim();
        if (!value) {
          const pending = ctx.listAttachments();
          if (pending.length === 0) {
            ctx.setFeedbackMessage('No image attachments pending. Usage: /attach <path>');
          } else {
            const summary = pending.map((a, i) => `${i + 1}: ${a.path}`).join(', ');
            ctx.setFeedbackMessage(`Pending attachments: ${summary}`);
          }
          return;
        }
        const result = ctx.attachImage(value);
        if (!result.ok) {
          ctx.setFeedbackError(`Cannot attach: ${result.reason}`);
          return;
        }
        ctx.setFeedbackMessage(`Attached: ${result.path}`);
      },
    },
    {
      kind: 'arg',
      name: '/detach',
      label: 'Detach',
      description: 'Remove a pending image attachment by index or id',
      validScreens: ['home', 'workflow'],
      handler: (args) => {
        const value = args?.trim();
        if (!value) {
          ctx.setFeedbackError('Usage: /detach <index|id>');
          return;
        }
        if (ctx.detachImage(value)) {
          ctx.setFeedbackMessage(`Detached: ${value}`);
        } else {
          ctx.setFeedbackError(`No attachment matched: ${value}`);
        }
      },
    },
    {
      kind: 'arg',
      name: '/approval',
      label: 'Approval',
      description: 'List or clear sticky approval grants',
      validScreens: ['workflow', 'summary'],
      handler: (args) => {
        const sub = args?.trim().toLowerCase();
        if (!sub || sub === 'list') {
          const grants = ctx.listApprovals();
          if (grants.length === 0) {
            ctx.setFeedbackMessage('No sticky approvals on record.');
          } else {
            const summary = grants.map((g) => `${g.pattern} (${g.class}, ${g.scope})`).join(', ');
            ctx.setFeedbackMessage(`Approvals: ${summary}`);
          }
          return;
        }
        if (sub === 'clear') {
          const count = ctx.clearApprovals();
          ctx.setFeedbackMessage(`Cleared ${count} approval grant(s).`);
          return;
        }
        ctx.setFeedbackError(`Unknown approval command: ${sub}. Use: /approval list or /approval clear`);
      },
    },
    {
      kind: 'noarg',
      name: '/accept-run',
      label: 'Accept Run',
      description: 'Accept current run changes and prevent run rejection',
      validScreens: ['workflow', 'summary'],
      handler: async () => {
        try {
          const result = await ctx.acceptRunSnapshot();
          ctx.setFeedbackMessage(`Run accepted at snapshot ${result.snapshotId}`);
        } catch (err) {
          ctx.setFeedbackError(toErrorMessage(err));
        }
      },
    },
    {
      kind: 'arg',
      name: '/reject-run',
      label: 'Reject Run',
      description: 'Restore diptych-written files from the run baseline',
      validScreens: ['workflow', 'summary'],
      handler: async (args) => {
        if (args?.trim().toLowerCase() !== 'confirm') {
          ctx.setFeedbackError('Usage: /reject-run confirm');
          return;
        }
        try {
          const result = await ctx.rejectRunSnapshot();
          if (result.status === 'empty') {
            ctx.setFeedbackError('No run snapshot to reject.');
            return;
          }
          if (result.status === 'accepted') {
            ctx.setFeedbackError(`Run already accepted at snapshot ${result.snapshotId}.`);
            return;
          }
          const changedCount = result.restoredPaths.length + result.deletedPaths.length;
          const conflictText = result.conflictedPaths.length > 0
            ? `, ${result.conflictedPaths.length} conflict(s)`
            : '';
          const missingText = result.missingSnapshotFiles.length > 0
            ? `, ${result.missingSnapshotFiles.length} missing snapshot file(s)`
            : '';
          const message = `Run rejected from snapshot ${result.snapshotId}: ${changedCount} file(s) restored/deleted${conflictText}${missingText}.`;
          if (result.conflictedPaths.length > 0 || result.missingSnapshotFiles.length > 0) {
            ctx.setFeedbackError(message);
          } else {
            ctx.setFeedbackMessage(message);
          }
        } catch (err) {
          ctx.setFeedbackError(toErrorMessage(err));
        }
      },
    },
    {
      kind: 'noarg',
      name: '/yolo',
      label: 'YOLO',
      description: 'Toggle approval gates off/on (skip all confirmations)',
      validScreens: ALL_SCREENS,
      handler: () => {
        const current = ctx.getApprovalEnabled();
        const next = !current;
        ctx.setApprovalEnabled(next);
        if (!next) {
          ctx.setFeedbackMessage('YOLO mode ON — all approval gates disabled');
        } else {
          ctx.setFeedbackMessage('YOLO mode OFF — approval gates restored');
        }
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
