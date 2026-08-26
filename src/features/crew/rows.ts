import {
  clearReviewerSeat,
  updateActiveRunner,
} from '../../core/config/accessors/active-runner.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import { crossLabVerdict, resolveLab, type CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import type { CrewRow } from '../../core/crew/rows.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { seatPickerOverlayFor } from '../../core/navigation/types.js';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import { reportConfigSaveFailure } from '../../stores/project/save-feedback.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { assertNever } from '../../utils/type-guards.js';

export type CrewActivationTarget =
  | Readonly<{ kind: 'crew'; row: CrewRow }>
  | Readonly<{ kind: 'preset'; preset: CrewPreset }>;

export type CrewActivation =
  | Readonly<{ kind: 'opened' }>
  | Readonly<{ kind: 'applied'; config: Config }>
  | Readonly<{ kind: 'inert' }>;

export function crewVerdict(rows: readonly CrewRow[]): CrewLabVerdict | undefined {
  const seatRunner = (id: CrewSeatId) => {
    for (const row of rows) if (row.kind === 'seat' && row.id === id) return row.seat.runner;
    return undefined;
  };
  const build = seatRunner('build');
  const review = seatRunner('review');
  if (build === undefined || review === undefined) return undefined;
  return crossLabVerdict({ build: resolveLab(build), review: resolveLab(review) });
}

function withPresetSeats(config: Config, preset: CrewPreset): Config {
  const seats = preset.seats;
  const withPlanner = updateActiveRunner({
    config,
    role: 'planner',
    updater: () => seats.planner,
  });
  const withImplementer = updateActiveRunner({
    config: withPlanner,
    role: 'implementer',
    updater: () => seats.implementer,
  });
  const reviewer = seats.reviewer;
  if (reviewer === undefined) return clearReviewerSeat(withImplementer);
  return updateActiveRunner({
    config: withImplementer,
    role: 'reviewer',
    updater: () => reviewer,
  });
}

async function persistCrew(config: Config, label: string): Promise<void> {
  const result = await configStore.save(config);
  if (reportConfigSaveFailure(result)) return;
  feedbackStore.setMessage(`Crew set to ${label}`);
}

/** An effort row is cycled in place by its list, so activating it is deliberately nothing. */
function openCrewRow(row: CrewRow): CrewActivation {
  switch (row.kind) {
    case 'seat':
      overlayStore.open(seatPickerOverlayFor(CREW_SEAT_ROLES[row.id]));
      return { kind: 'opened' };
    case 'escalate':
      overlayStore.open(seatPickerOverlayFor('escalation'));
      return { kind: 'opened' };
    case 'effort':
      return { kind: 'inert' };
    default:
      return assertNever(row);
  }
}

export function crewActivate(
  input: Readonly<{ target: CrewActivationTarget; config: Config }>,
): CrewActivation {
  const { target } = input;
  if (target.kind === 'crew') return openCrewRow(target.row);

  const config = withPresetSeats(input.config, target.preset);
  void persistCrew(config, target.preset.label);
  return { kind: 'applied', config };
}
