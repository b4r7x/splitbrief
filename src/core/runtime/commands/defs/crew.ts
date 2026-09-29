import { ALL_SCREENS, seatPickerOverlayFor } from '../../../navigation/types.js';
import { CREW_SEAT_ROLES } from '../../../crew/seats.js';
import { describeModeShape } from '../../../pipeline-spec/mode-shape.js';
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
      args: {
        kind: 'closed',
        options: WORKFLOW_MODES,
        optionDescriptions: Object.fromEntries(
          WORKFLOW_MODES.map((mode) => [mode, describeModeShape(mode, { gateNames: true })]),
        ),
        optionHints: { [ctx.getWorkflowMode()]: 'current' },
        optional: true,
      },
      validScreens: ALL_SCREENS,
      handler: async (args) => {
        if (!args) {
          // Bare `/mode` stays in the composer: the option rows are the picker.
          ctx.prefillComposer('/mode ');
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
          // A started run keeps the mode it saved, so the mode set here is the next run's. The
          // result leads, so a narrow row cuts the merge notice rather than the result.
          const message = `Workflow mode set to: ${mode} for the next run`;
          ctx.setFeedbackMessage(
            requested === RETIRED_WORKFLOW_MODE
              ? `${message}; ${RETIRED_WORKFLOW_MODE} was merged into ${mode}`
              : message,
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
