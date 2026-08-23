import {
  clearReviewerSeat,
  updateActiveRunner,
} from '../../core/config/accessors/active-runner.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import type { CrewSeat, CrewSeatId } from '../../core/crew/seats.js';
import type { OverlayType } from '../../core/navigation/types.js';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import { reportConfigSaveFailure } from '../../stores/project/save-feedback.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';

const CREW_SEAT_PICKER: Readonly<Record<CrewSeatId, OverlayType>> = {
  plan: 'planner-picker',
  build: 'implementer-picker',
  review: 'reviewer-picker',
};

export type CrewFocusRow =
  | Readonly<{ kind: 'preset'; id: string }>
  | Readonly<{ kind: 'seat'; id: CrewSeatId }>
  | Readonly<{ kind: 'continue' }>;

export function crewFocusRows(
  input: Readonly<{
    presets: readonly CrewPreset[];
    seats: readonly CrewSeat[];
    continueRow: boolean;
  }>,
): readonly CrewFocusRow[] {
  return [
    ...input.presets.map((preset): CrewFocusRow => ({ kind: 'preset', id: preset.id })),
    ...input.seats.map((seat): CrewFocusRow => ({ kind: 'seat', id: seat.id })),
    ...(input.continueRow ? [{ kind: 'continue' } as const] : []),
  ];
}

export function crewFocusKey(row: CrewFocusRow): string {
  return row.kind === 'continue' ? 'continue' : `${row.kind}:${row.id}`;
}

/**
 * Discovery can add or drop presets while the surface is open, so focus is held by row identity;
 * a row that is no longer offered hands focus to the first seat rather than to its neighbour.
 */
export function crewFocusIndex(
  input: Readonly<{ rows: readonly CrewFocusRow[]; key: string | undefined }>,
): number {
  const found = input.rows.findIndex((row) => crewFocusKey(row) === input.key);
  return found >= 0 ? found : input.rows.findIndex((row) => row.kind === 'seat');
}

export function crewFocusMove(
  input: Readonly<{ rows: readonly CrewFocusRow[]; index: number; delta: number }>,
): string | undefined {
  const row = input.rows[Math.min(input.rows.length - 1, Math.max(0, input.index + input.delta))];
  return row === undefined ? undefined : crewFocusKey(row);
}

export function crewActivate(
  input: Readonly<{
    row: CrewFocusRow | undefined;
    presets: readonly CrewPreset[];
    config: Config;
  }>,
): void {
  const { row } = input;
  if (row?.kind === 'seat') {
    overlayStore.open(CREW_SEAT_PICKER[row.id]);
    return;
  }
  if (row?.kind !== 'preset') return;
  const preset = input.presets.find((candidate) => candidate.id === row.id);
  if (preset !== undefined) void applyCrewPreset({ config: input.config, preset });
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

export async function applyCrewPreset(
  input: Readonly<{ config: Config; preset: CrewPreset }>,
): Promise<boolean> {
  const result = await configStore.save(withPresetSeats(input.config, input.preset));
  if (reportConfigSaveFailure(result)) return false;
  feedbackStore.setMessage(`Crew set to ${input.preset.label}`);
  return true;
}
