import {
  SCROLL_COMMAND_TARGETS,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
  type ScrollCommandTarget,
} from '../types.js';
import { getShortcutKey } from '../../../keybindings/registry.js';
import { includes } from '../../../../utils/type-guards.js';

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

export function viewCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  return [
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
  ];
}
