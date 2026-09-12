import {
  APPROVAL_ACTIONS,
  QUEUE_ACTIONS,
  RUN_ACTIONS,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
} from '../types.js';
import { includes } from '../../../../utils/type-guards.js';
import { canRedoTask, canRevisePlan, canReviseSpec, isLivePhase } from '../../../phases.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { countNoun, pluralize } from '../../../../utils/pluralize.js';
import { formatRejectRunMessage } from '../messages.js';

export function workflowCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  return [
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
  ];
}
