import {
  QUEUE_ACTIONS,
  RUN_ACTIONS,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
} from '../types.js';
import { includes } from '../../../../utils/type-guards.js';
import { canRedoTask, isLivePhase } from '../../../phases.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { countNoun, pluralize } from '../../../../utils/pluralize.js';
import { formatRejectRunMessage } from '../messages.js';

export function workflowCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  return [
    {
      kind: 'noarg',
      name: '/stop',
      label: 'session options',
      description: 'Open stop and session options',
      category: 'workflow',
      validScreens: ['workflow'],
      handler: () => ctx.openOverlay('stop-sheet'),
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
      kind: 'noarg',
      name: '/resume',
      label: 'resume',
      description: 'Continue a paused or stopped run',
      category: 'workflow',
      validScreens: ['workflow'],
      guard: (c) =>
        c.openRunAtRest || isLivePhase(c.phase) ? undefined : 'No run to resume in this phase',
      handler: () => {
        if (!ctx.resumeRun()) ctx.setFeedbackError('Nothing to resume.');
      },
    },
    {
      kind: 'noarg',
      name: '/end',
      label: 'end run',
      description: 'Close the run, keeping every change on disk',
      category: 'workflow',
      validScreens: ['workflow'],
      guard: (c) =>
        c.openRunAtRest || isLivePhase(c.phase) ? undefined : 'No run to end in this phase',
      handler: () => {
        if (!ctx.endRun()) ctx.setFeedbackError('No active run to end.');
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
      name: '/run',
      label: 'run',
      description: 'Accept or reject what this run wrote',
      category: 'workflow',
      args: { kind: 'closed', options: RUN_ACTIONS },
      validScreens: ['workflow'],
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
            ctx.refreshRun();
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
          ctx.refreshRun();
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
