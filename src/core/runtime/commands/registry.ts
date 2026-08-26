import { ALL_SCREENS } from '../../navigation/types.js';
import { glyph } from '../../../lib/glyphs.js';
import { WORKFLOW_MODES } from '../../schemas/enums.js';
import {
  APPROVAL_ACTIONS,
  COPY_TARGETS,
  CREW_COMMAND_SEATS,
  IMAGE_ACTIONS,
  QUEUE_ACTIONS,
  RUN_ACTIONS,
  SCROLL_COMMAND_TARGETS,
  formatDiscoveryRefreshFeedback,
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
      description: 'Show help',
      shortcut: getShortcutKey('help'),
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('help'),
    },
    {
      kind: 'noarg',
      name: '/palette',
      label: 'palette',
      description: 'Open command palette',
      category: 'navigate',
      hidden: true,
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('command-palette'),
    },
    {
      kind: 'noarg',
      name: '/skills',
      label: 'skills',
      description: 'Select planner skills',
      shortcut: getShortcutKey('skills'),
      category: 'navigate',
      validScreens: ['home'],
      handler: () => ctx.openOverlay('skills'),
    },
    {
      kind: 'noarg',
      name: '/sessions',
      label: 'sessions',
      description: 'Browse past sessions',
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('sessions'),
    },
    {
      kind: 'noarg',
      name: '/settings',
      aliases: [{ name: '/config' }],
      label: 'settings',
      description: 'Crew, validation, workflow',
      shortcut: getShortcutKey('settings'),
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('settings'),
    },
    {
      kind: 'arg',
      name: '/crew',
      aliases: [
        { name: '/planner', args: 'plan' },
        { name: '/implementer', args: 'build' },
        { name: '/reviewer', args: 'review' },
      ],
      label: 'crew',
      description: 'Who fills each seat',
      category: 'crew',
      args: { kind: 'closed', options: CREW_COMMAND_SEATS, optional: true },
      validScreens: ALL_SCREENS,
      handler: (args) => {
        const seat = args?.trim().toLowerCase();
        if (seat && !includes(CREW_COMMAND_SEATS, seat)) {
          ctx.setFeedbackError(`Unknown seat: ${seat}. Valid: ${CREW_COMMAND_SEATS.join(', ')}`);
          return;
        }
        ctx.openOverlay('settings', `seat:${seat ?? 'plan'}`);
      },
    },
    {
      kind: 'arg',
      name: '/mode',
      label: 'mode',
      description: 'Workflow mode',
      category: 'crew',
      args: { kind: 'closed', options: WORKFLOW_MODES, optional: true },
      validScreens: ALL_SCREENS,
      handler: async (args) => {
        if (!args) {
          ctx.openOverlay('mode-selector');
          return;
        }
        const mode = args.trim().toLowerCase();
        if (!includes(WORKFLOW_MODES, mode)) {
          ctx.setFeedbackError(`Invalid mode: ${mode}. Valid modes: ${WORKFLOW_MODES.join(', ')}`);
          return;
        }
        if ((await ctx.setWorkflowMode(mode)).kind === 'saved') {
          ctx.setFeedbackMessage(`Workflow mode set to: ${mode}`);
        }
      },
    },
    {
      kind: 'arg',
      name: '/copy',
      label: 'copy',
      description: `Copy to clipboard: ${COPY_TARGETS.join(' | ')}`,
      category: 'io',
      args: { kind: 'closed', options: COPY_TARGETS, optional: true },
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
      kind: 'noarg',
      name: '/home',
      label: 'home',
      description: 'Return to home screen',
      category: 'navigate',
      validScreens: ['workflow', 'summary'],
      handler: () => ctx.navigate('home'),
    },
    {
      kind: 'arg',
      name: '/scroll',
      label: 'scroll',
      description: `Scroll conversation: ${SCROLL_COMMAND_TARGETS.join(' | ')}`,
      category: 'view',
      args: { kind: 'closed', options: SCROLL_COMMAND_TARGETS },
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
      description: 'Expand or collapse the latest activity batch',
      shortcut: getShortcutKey('activity'),
      category: 'view',
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
      description: 'Show or hide workflow sidebar',
      category: 'view',
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
      description: 'Re-detect available tools',
      category: 'crew',
      validScreens: ALL_SCREENS,
      handler: async () => {
        ctx.setFeedbackMessage('Refreshing tool detection…');
        ctx.refreshProjectFiles();
        try {
          const summary = await ctx.refreshDetection();
          const feedback = formatDiscoveryRefreshFeedback({
            subject: 'Tool detection',
            summary,
          });
          if (feedback.isError) ctx.setFeedbackError(feedback.message);
          else ctx.setFeedbackMessage(feedback.message);
        } catch (err) {
          ctx.setFeedbackError(toErrorMessage(err));
        }
      },
    },
    {
      kind: 'arg',
      name: '/revise-spec',
      label: 'revise spec',
      description: 'Rewind to spec phase with optional feedback',
      category: 'workflow',
      args: { kind: 'free', hint: '[feedback]' },
      validScreens: ['workflow'],
      guard: (c) => (canReviseSpec(c.phase) ? undefined : 'No spec to revise in this phase'),
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
      description: 'Rewind to plan phase with optional feedback',
      category: 'workflow',
      args: { kind: 'free', hint: '[feedback]' },
      validScreens: ['workflow'],
      guard: (c) => (canRevisePlan(c.phase) ? undefined : 'No plan to revise in this phase'),
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
      description: 'Reset a task to pending and re-run it',
      category: 'workflow',
      args: { kind: 'free', hint: '<task-id>' },
      validScreens: ['workflow'],
      guard: (c) =>
        canRedoTask(c.phase) ? undefined : 'Tasks can only be redone while implementing',
      handler: (args) => {
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
      description: 'Show or clear the message queue',
      category: 'workflow',
      args: { kind: 'closed', options: QUEUE_ACTIONS, optional: true },
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
      description: `Export handoff pack for an external agent ${glyph('connectorHandoff')}`,
      category: 'workflow',
      args: { kind: 'closed', options: HANDOFF_TARGETS },
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
      description: 'Export session as HTML report',
      category: 'io',
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
      description: 'Summarize older transcript turns',
      category: 'io',
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
      name: '/approval',
      label: 'approval',
      description: 'List or clear sticky approval grants',
      category: 'workflow',
      args: { kind: 'closed', options: APPROVAL_ACTIONS, optional: true },
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
      kind: 'arg',
      name: '/run',
      aliases: [
        { name: '/accept-run', args: 'accept' },
        { name: '/reject-run', args: 'reject' },
      ],
      label: 'run',
      description: 'Accept or reject what this run wrote',
      category: 'workflow',
      args: { kind: 'closed', options: RUN_ACTIONS },
      validScreens: ['workflow', 'summary'],
      handler: async (args) => {
        const [action = '', confirmation] = (args ?? '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        if (!includes(RUN_ACTIONS, action)) {
          ctx.setFeedbackError(`Usage: /run <${RUN_ACTIONS.join('|')}>`);
          return;
        }
        if (action === 'accept') {
          try {
            const result = await ctx.acceptRunSnapshot();
            ctx.setFeedbackMessage(`Run accepted at snapshot ${result.snapshotId}`);
          } catch (err) {
            ctx.setFeedbackError(toErrorMessage(err));
          }
          return;
        }
        if (confirmation !== 'confirm') {
          ctx.setFeedbackError('Usage: /run reject confirm');
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
      kind: 'arg',
      name: '/image',
      aliases: [{ name: '/attach' }, { name: '/detach', args: 'remove' }],
      label: 'image',
      description: 'Attach, list or remove images for the next planner call',
      category: 'io',
      args: { kind: 'free', hint: `<path> | ${IMAGE_ACTIONS.join(' | ')} <index|id>` },
      validScreens: ['home', 'workflow'],
      guard: (c) =>
        c.plannerSupportsImages
          ? undefined
          : 'PLAN seat cannot see images — pick a vision model with /crew plan',
      handler: (args) => {
        const value = args?.trim() ?? '';
        const [first = '', ...rest] = value.split(/\s+/).filter(Boolean);
        const action = first.toLowerCase();
        if (value === '' || action === 'list') {
          const pending = ctx.listAttachments();
          if (pending.length === 0) {
            ctx.setFeedbackMessage('No image attachments pending. Usage: /image <path>');
            return;
          }
          const summary = pending.map((a, i) => `${i + 1}: ${a.path}`).join(', ');
          ctx.setFeedbackMessage(`Pending attachments: ${summary}`);
          return;
        }
        if (action === 'remove') {
          const target = rest.join(' ');
          if (!target) {
            ctx.setFeedbackError('Usage: /image remove <index|id>');
            return;
          }
          if (ctx.detachImage(target)) {
            ctx.setFeedbackMessage(`Removed: ${target}`);
          } else {
            ctx.setFeedbackError(`No attachment matched: ${target}`);
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
      kind: 'noarg',
      name: '/diff',
      label: 'diff',
      description: 'Expand or collapse the latest diff',
      shortcut: getShortcutKey('toggle-diff'),
      category: 'view',
      validScreens: ['workflow'],
      handler: () => {
        const result = ctx.toggleLatestDiff();
        if (result.status === 'unavailable') {
          ctx.setFeedbackError(result.message);
          return;
        }
        ctx.setFeedbackMessage(result.expanded ? 'Expanded latest diff' : 'Collapsed latest diff');
      },
    },
    {
      kind: 'noarg',
      name: '/cost',
      label: 'cost',
      description: 'Show the cost breakdown',
      shortcut: getShortcutKey('cost-drilldown'),
      category: 'view',
      validScreens: ['workflow'],
      handler: () => ctx.openOverlay('cost-drilldown'),
    },
    {
      kind: 'noarg',
      name: '/yolo',
      label: 'yolo',
      description: 'Toggle file-write tiered approvals off/on',
      category: 'workflow',
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
      description: 'Exit application',
      shortcut: getShortcutKey('quit'),
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.quit(),
    },
  ];

  if (ctx.isAttached) {
    return commands.filter((cmd) => ATTACHED_AVAILABLE_COMMANDS.has(cmd.name));
  }
  return commands;
}
