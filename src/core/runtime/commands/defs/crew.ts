import { ALL_SCREENS, seatPickerOverlayFor } from '../../../navigation/types.js';
import { CREW_SEAT_ROLES } from '../../../crew/seats.js';
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
      label: 'crew',
      description: 'Who fills each seat',
      category: 'crew',
      args: { kind: 'closed', options: CREW_COMMAND_SEATS, optional: true },
      validScreens: ALL_SCREENS,
      handler: (args) => {
        const seat = args?.trim().toLowerCase();
        if (!seat) {
          ctx.openOverlay('settings', 'seat:plan');
          return undefined;
        }
        if (!includes(CREW_COMMAND_SEATS, seat)) {
          return `Unknown seat: ${seat}. Valid: ${CREW_COMMAND_SEATS.join(', ')}`;
        }
        ctx.openOverlay(seatPickerOverlayFor(CREW_SEAT_ROLES[seat]));
        return undefined;
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
