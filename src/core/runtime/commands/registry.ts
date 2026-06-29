import { ALL_SCREENS } from '../../navigation/types.js';
import { glyph } from '../../../lib/glyphs.js';
import { EFFORT_LEVELS, WORKFLOW_MODES } from '../../schemas/enums.js';
import {
  COPY_TARGETS,
  SCROLL_COMMAND_TARGETS,
  formatCopyResult,
  type CopyTarget,
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

function parseCopyTarget(args: string | undefined): CopyTarget | null {
  const target = args?.trim().toLowerCase();
  if (!target) return 'message';
  return includes(COPY_TARGETS, target) ? target : null;
}

// Attached TUI clients drive a detached server over IPC. Keep only local-view commands and commands
// with explicit IPC handling; config/workflow mutations would otherwise report success while
// changing only the attached client.
export const ATTACHED_AVAILABLE_COMMANDS = new Set<string>([
  '/help',
  '/palette',
  '/sessions',
  '/copy',
  '/home',
  '/scroll',
  '/activity',
  '/sidebar',
  '/queue',
  '/quit',
]);

export function createRuntimeCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  const commands: RuntimeCommandDef[] = [
    {
      kind: 'noarg',
      name: '/help',
      label: 'help',
      description: 'show help overlay',
      shortcut: getShortcutKey('help'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('help'),
    },
    {
      kind: 'noarg',
      name: '/palette',
      label: 'palette',
      description: 'open command palette',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('command-palette'),
    },
    {
      kind: 'noarg',
      name: '/skills',
      label: 'skills',
      description: 'select planner skills',
      shortcut: getShortcutKey('skills'),
      validScreens: ['home'],
      handler: () => ctx.openOverlay('skills'),
    },
    {
      kind: 'noarg',
      name: '/sessions',
      label: 'sessions',
      description: 'browse past sessions',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('sessions'),
    },
    {
      kind: 'noarg',
      name: '/settings',
      aliases: ['/config'],
      label: 'settings',
      description: 'planner, model & settings',
      shortcut: getShortcutKey('settings'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('settings'),
    },
    {
      kind: 'arg',
      name: '/mode',
      label: 'mode',
      description: `select workflow mode ${glyph('connectorHandoff')}`,
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
      name: '/copy',
      label: 'copy',
      description: `copy to clipboard: ${COPY_TARGETS.join(' | ')}`,
      validScreens: ['workflow'],
      handler: async (args) => {
        const target = parseCopyTarget(args);
        if (target === null) {
          ctx.setFeedbackError(
            `Invalid copy target: ${args?.trim()}. Valid: ${COPY_TARGETS.join(', ')}`,
          );
          return;
        }
        ctx.setFeedbackMessage(formatCopyResult(await ctx.copyTarget(target)));
      },
    },
    {
      kind: 'arg',
      name: '/effort',
      label: 'effort',
      description: `set planner effort: ${EFFORT_LEVELS.join(' | ')}`,
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
      label: 'planner',
      description: 'select planner tool',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('planner-picker'),
    },
    {
      kind: 'noarg',
      name: '/implementer',
      label: 'implementer',
      description: 'select implementer',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('implementer-picker'),
    },
    {
      kind: 'noarg',
      name: '/home',
      label: 'home',
      description: 'return to home screen',
      validScreens: ['workflow', 'summary'],
      handler: () => ctx.navigate('home'),
    },
    {
      kind: 'arg',
      name: '/scroll',
      label: 'scroll',
      description: `scroll conversation: ${SCROLL_COMMAND_TARGETS.join(' | ')}`,
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
      label: 'activity',
      description: 'expand or collapse the latest activity batch',
      shortcut: getShortcutKey('activity'),
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
      name: '/sidebar',
      label: 'sidebar',
      description: 'show or hide workflow sidebar',
      validScreens: ['workflow'],
      handler: () => {
        const result = ctx.toggleSidebar();
        if (result.status === 'unavailable') {
          ctx.setFeedbackError(result.message);
          return;
        }
        ctx.setFeedbackMessage(result.visible ? 'Sidebar shown' : 'Sidebar hidden');
      },
    },
    {
      kind: 'noarg',
      name: '/refresh',
      label: 'refresh',
      description: 're-detect available tools',
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
      label: 'revise spec',
      description: 'rewind to spec phase with optional feedback',
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
      label: 'revise plan',
      description: 'rewind to plan phase with optional feedback',
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
      label: 'redo task',
      description: 'reset a task to pending and re-run it',
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
      label: 'queue',
      description: 'show or clear the message queue',
      validScreens: ['workflow'],
      handler: async (args) => {
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
          const result = await ctx.clearQueue();
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
      label: 'handoff',
      description: `export handoff pack for an external agent ${glyph('connectorHandoff')}`,
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
      label: 'export',
      description: 'export session as HTML report',
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
      label: 'compact transcript',
      description: 'summarize older transcript turns',
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
      label: 'repomap',
      description: 'manage the repo-map cache',
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
      label: 'attach',
      description: 'attach an image for the next planner call',
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
      label: 'detach',
      description: 'remove a pending image attachment by index or id',
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
      label: 'approval',
      description: 'list or clear sticky approval grants',
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
      label: 'accept run',
      description: 'accept current run changes and prevent run rejection',
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
      label: 'reject run',
      description: 'restore diptych-written files from the run baseline',
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
      label: 'yolo',
      description: 'toggle file-write tiered approvals off/on',
      validScreens: ALL_SCREENS,
      handler: () => {
        const current = ctx.getApprovalEnabled();
        const next = !current;
        ctx.setApprovalEnabled(next);
        if (!next) {
          ctx.setFeedbackMessage('YOLO mode ON — file-write tiered approvals disabled');
        } else {
          ctx.setFeedbackMessage('YOLO mode OFF — file-write tiered approvals restored');
        }
      },
    },
    {
      kind: 'noarg',
      name: '/quit',
      label: 'quit',
      description: 'exit application',
      shortcut: getShortcutKey('quit'),
      validScreens: ALL_SCREENS,
      handler: () => ctx.quit(),
    },
  ];

  if (ctx.isAttached) {
    return commands.filter((cmd) => ATTACHED_AVAILABLE_COMMANDS.has(cmd.name));
  }
  return commands;
}
