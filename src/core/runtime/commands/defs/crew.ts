import { ALL_SCREENS, seatPickerOverlayFor } from '../../../navigation/types.js';
import { CREW_SEAT_ROLES } from '../../../crew/seats.js';
import {
  RETIRED_WORKFLOW_MODE,
  WORKFLOW_MODES,
  normalizeWorkflowMode,
} from '../../../schemas/enums.js';
import {
  CREW_COMMAND_SEATS,
  formatDiscoveryRefreshFeedback,
  type RuntimeCommandDef,
  type RuntimeCommandContext,
} from '../types.js';
import { includes } from '../../../../utils/type-guards.js';
import { toErrorMessage } from '../../../../utils/format-errors.js';

export function crewCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  return [
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
        if (!seat) {
          ctx.openOverlay('settings', 'seat:plan');
          return;
        }
        if (!includes(CREW_COMMAND_SEATS, seat)) {
          ctx.setFeedbackError(`Unknown seat: ${seat}. Valid: ${CREW_COMMAND_SEATS.join(', ')}`);
          return;
        }
        ctx.openOverlay(seatPickerOverlayFor(CREW_SEAT_ROLES[seat]));
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
        const requested = args.trim().toLowerCase();
        const mode = normalizeWorkflowMode(requested);
        if (!mode) {
          ctx.setFeedbackError(
            `Invalid mode: ${requested}. Valid modes: ${WORKFLOW_MODES.join(', ')}`,
          );
          return;
        }
        if ((await ctx.setWorkflowMode(mode)).kind === 'saved') {
          ctx.setFeedbackMessage(
            requested === RETIRED_WORKFLOW_MODE
              ? `${RETIRED_WORKFLOW_MODE} was merged into ${mode}; workflow mode set to: ${mode}`
              : `Workflow mode set to: ${mode}`,
          );
        }
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
  ];
}
