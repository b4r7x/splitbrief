import { ALL_SCREENS } from '../../navigation/types.js';
import { EFFORT_LEVELS, WORKFLOW_MODES } from '../../schemas/enums.js';
import {
  SCROLL_COMMAND_TARGETS,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
  type ScrollCommandTarget,
} from './types.js';
import { getShortcutKey } from '../../keybindings/registry.js';
import { includes } from '../../../utils/type-guards.js';
import { canRedoTask, canRevisePlan, canReviseSpec, isLivePhase } from '../../phases.js';
import { HANDOFF_TARGETS, parseHandoffTarget } from '../../handoff/targets.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { formatRejectRunMessage } from './messages.js';

const SCROLL_COMMAND_USAGE = `/scroll <${SCROLL_COMMAND_TARGETS.join('|')}>`;
const SCROLL_FEEDBACK = {
  top: 'to top',
  bottom: 'to bottom',
  'page-up': 'up one page',
  'page-down': 'down one page',
} satisfies Record<ScrollCommandTarget, string>;

function parseScrollCommandTarget(args: string | undefined): ScrollCommandTarget | null {
  const target = args?.trim().toLowerCase();
  if (!target) return null;
  return includes(SCROLL_COMMAND_TARGETS, target) ? target : null;
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
      description: 'Select workflow mode →',
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
      kind: 'arg',
      name: '/scroll',
      label: 'Scroll',
      description: `Scroll conversation: ${SCROLL_COMMAND_TARGETS.join(' | ')}`,
      validScreens: ['workflow'],
      handler: (args) => {
        const target = parseScrollCommandTarget(args);
        if (target === null) {
          const value = args?.trim();
          const prefix = value ? `Invalid scroll target: ${value}. ` : '';
          ctx.setFeedbackError(`${prefix}Usage: ${SCROLL_COMMAND_USAGE}`);
          return;
        }
        const result = ctx.scrollConversation(target);
        if (result.status === 'unavailable') {
          ctx.setFeedbackError(result.message);
          return;
        }
        ctx.setFeedbackMessage(`Scrolled conversation ${SCROLL_FEEDBACK[target]}`);
      },
    },
    {
      kind: 'noarg',
      name: '/activity',
      label: 'Activity',
      description: 'Expand or collapse the latest activity batch',
      validScreens: ['workflow'],
      handler: () => {
        const result = ctx.toggleLatestActivityBatch();
        if (result.status === 'unavailable') {
          ctx.setFeedbackError(result.message);
          return;
        }
        ctx.setFeedbackMessage(
          result.expanded ? 'Expanded latest activity batch' : 'Collapsed latest activity batch',
        );
      },
    },
    {
      kind: 'noarg',
      name: '/refresh',
      label: 'Refresh',
      description: 'Re-detect available tools',
      validScreens: ALL_SCREENS,
      handler: async () => {
        ctx.setFeedbackMessage('Refreshing tool detection…');
        ctx.refreshProjectFiles();
        try {
          await ctx.refreshDetection();
          ctx.setFeedbackMessage('Tool detection refreshed');
        } catch (err) {
          ctx.setFeedbackError(toErrorMessage(err));
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
            ctx.setFeedbackMessage(`Queue: ${countNoun(depth, 'message')} pending`);
          }
          return;
        }
        if (sub === 'clear') {
          const result = ctx.clearQueue();
          if (result.status === 'unavailable') {
            ctx.setFeedbackError(result.message);
            return;
          }
          if (result.count > 0) {
            ctx.setFeedbackMessage(
              `Cleared ${result.count} queued ${pluralize(result.count, 'message')}`,
            );
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
            ctx.setFeedbackMessage(
              `Planner "${result.plannerName}" does not support transcript compaction.`,
            );
            return;
          }
          const count = result.entriesRemoved;
          ctx.setFeedbackMessage(
            `Transcript compacted: ${count} older ${pluralize(count, 'message')} summarized.`,
          );
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
              ctx.setFeedbackMessage(
                'Repomap cache cleared. Next planner phase will parse from scratch.',
              );
            } else {
              ctx.setFeedbackMessage('Repomap cache was not present.');
            }
          } catch (err) {
            ctx.setFeedbackError(toErrorMessage(err));
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
        ctx.setFeedbackError(
          `Unknown approval command: ${sub}. Use: /approval list or /approval clear`,
        );
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
        if (isLivePhase(ctx.getCurrentPhase())) {
          ctx.setFeedbackError('Run rejection is unavailable while work is active.');
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
          const message = formatRejectRunMessage(result);
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
      description: 'Toggle action-level tiered approvals off/on',
      validScreens: ALL_SCREENS,
      handler: () => {
        const current = ctx.getApprovalEnabled();
        const next = !current;
        ctx.setApprovalEnabled(next);
        if (!next) {
          ctx.setFeedbackMessage('YOLO mode ON — action-level tiered approvals disabled');
        } else {
          ctx.setFeedbackMessage('YOLO mode OFF — action-level tiered approvals restored');
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
