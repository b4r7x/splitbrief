import {
  COPY_TARGETS,
  IMAGE_ACTIONS,
  formatCopyResult,
  type CopyTarget,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
} from '../types.js';
import { includes } from '../../../../utils/type-guards.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';
import { pluralize } from '../../../../utils/pluralize.js';

function parseCopyTarget(args: string | undefined): CopyTarget | null {
  const target = args?.trim().toLowerCase();
  if (!target) return 'message';
  return includes(COPY_TARGETS, target) ? target : null;
}

export function ioCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  return [
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
      name: '/image',
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
  ];
}
