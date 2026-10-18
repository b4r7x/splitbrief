import {
  QUEUE_ACTIONS,
  RUN_ACTIONS,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
} from '../types.js';
import { assertNever, includes } from '../../../../utils/type-guards.js';
import { isLivePhase } from '../../../phases.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { countNoun } from '../../../../utils/pluralize.js';
import {
  APPLY_UNFINISHED_REFUSAL,
  formatApplyRestoreCounts,
  rejectRunFeedback,
  runRejectFacts,
} from '../messages.js';

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
      kind: 'arg',
      name: '/steer',
      label: 'steer',
      description: 'Stop now and continue with your correction',
      category: 'workflow',
      args: { kind: 'free', hint: 'correction' },
      validScreens: ['workflow'],
      guard: (c) =>
        c.openRunAtRest || isLivePhase(c.phase) ? undefined : 'No run to steer in this phase',
      handler: (args) => {
        const text = args?.trim() ?? '';
        if (text === '') {
          ctx.setFeedbackError('Usage: /steer <correction>');
          return;
        }
        if (!ctx.steerRun(text)) ctx.setFeedbackError('Nothing to steer.');
      },
    },
    {
      kind: 'noarg',
      name: '/end',
      label: 'end run',
      description: 'Close the run, saving unapplied changes',
      category: 'workflow',
      validScreens: ['workflow'],
      guard: (c) => {
        if (c.applyUnfinished) return APPLY_UNFINISHED_REFUSAL;
        return c.openRunAtRest || isLivePhase(c.phase) ? undefined : 'No run to end in this phase';
      },
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
          ctx.setFeedbackMessage(ctx.getQueueCopy().summary);
          return;
        }
        if (sub === 'clear') {
          const result = await ctx.clearQueue();
          if (result.status === 'unavailable') {
            ctx.setFeedbackError(result.message);
            return;
          }
          ctx.setFeedbackMessage(ctx.getQueueCopy(result.count).clearFeedback);
          return;
        }
        ctx.setFeedbackError(`Unknown queue command: ${sub}. Use: /queue show or /queue clear`);
      },
    },
    {
      kind: 'arg',
      name: '/run',
      label: 'run',
      description: 'Apply or discard this run, or undo its Apply',
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
            const result = await ctx.acceptRun(confirmation === 'confirm');
            switch (result.status) {
              case 'snapshot-accepted':
                ctx.setFeedbackMessage(`Run accepted at snapshot ${result.snapshotId}`);
                ctx.refreshRun();
                break;
              case 'applied':
                ctx.refreshRun();
                ctx.setFeedbackMessage(
                  `Applied ${countNoun(result.files.length, 'file')} to your checkout.`,
                );
                break;
              case 'ended':
                ctx.refreshRun();
                ctx.setFeedbackMessage(
                  'Run closed as it is; its changes are already in your checkout.',
                );
                break;
              case 'review':
                ctx.refreshRun();
                ctx.setFeedbackMessage(
                  'Your checkout changed files this run changed too; the merged result needs its checks and review again. Continue the run to start them.',
                );
                break;
              case 'confirm-override':
                break;
              case 'halted':
                ctx.refreshRun();
                ctx.setFeedbackError('Apply stopped; resolve it in the recovery menu.');
                break;
              case 'unavailable':
                ctx.setFeedbackError(result.message);
                break;
              default:
                assertNever(result);
            }
          } catch (err) {
            ctx.setFeedbackError(toErrorMessage(err));
          }
          return;
        }
        if (confirmation !== 'confirm') {
          ctx.setFeedbackError('Usage: /run reject confirm');
          return;
        }
        try {
          const result = await ctx.rejectRun();
          switch (result.status) {
            case 'empty':
              ctx.setFeedbackError('No run snapshot to reject.');
              break;
            case 'accepted':
              ctx.setFeedbackError(`Run already accepted at snapshot ${result.snapshotId}.`);
              break;
            case 'rejected': {
              ctx.refreshRun();
              const feedback = rejectRunFeedback(runRejectFacts(result));
              if (feedback.isError) ctx.setFeedbackError(feedback.message);
              else ctx.setFeedbackMessage(feedback.message);
              break;
            }
            case 'discarded':
              ctx.refreshRun();
              ctx.setFeedbackMessage(
                'Run discarded; its changes are saved in run.patch in the session folder.',
              );
              break;
            case 'undone': {
              ctx.refreshRun();
              const message = `Apply undone: ${formatApplyRestoreCounts(result)}`;
              if (result.conflicts.length > 0) {
                ctx.setFeedbackError(
                  `${message}; left as you changed them: ${result.conflicts.join(', ')}.`,
                );
              } else {
                ctx.setFeedbackMessage(`${message}.`);
              }
              break;
            }
            case 'unavailable':
              ctx.setFeedbackError(result.message);
              break;
            default:
              assertNever(result);
          }
        } catch (err) {
          ctx.setFeedbackError(toErrorMessage(err));
        }
      },
    },
  ];
}
