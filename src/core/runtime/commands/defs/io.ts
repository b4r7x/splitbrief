import {
  COPY_TARGETS,
  IMAGE_ACTIONS,
  formatCopyResult,
  type CopyTarget,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
} from '../types.js';
import { includes } from '../../../../utils/type-guards.js';
import { formatAttachmentFailure } from '../../../attachments/failure.js';

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
          return `Invalid copy target: ${args?.trim()}. Valid: ${COPY_TARGETS.join(', ')}`;
        }
        ctx.setFeedbackMessage(formatCopyResult(await ctx.copyTarget(target)));
        return undefined;
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
            return undefined;
          }
          const summary = pending.map((a, i) => `${i + 1}: ${a.path}`).join(', ');
          ctx.setFeedbackMessage(`Pending attachments: ${summary}`);
          return undefined;
        }
        if (action === 'remove') {
          const target = rest.join(' ');
          if (!target) return 'Usage: /image remove <index|id>';
          if (!ctx.detachImage(target)) return `No attachment matched: ${target}`;
          ctx.setFeedbackMessage(`Removed: ${target}`);
          return undefined;
        }
        const result = (ctx.insertImage ?? ctx.attachImage)(value);
        if (!result.ok) {
          return result.reason === 'no-vision'
            ? 'Cannot attach image: the planner cannot see images. Choose a vision model with /crew plan.'
            : formatAttachmentFailure({ action: 'attach-image', reason: result.reason });
        }
        ctx.setFeedbackMessage(`Attached: ${result.path}`);
        return undefined;
      },
    },
  ];
}
