import {
  clearReviewerSeat,
  readActiveRunner,
  updateActiveRunner,
} from '../../core/config/accessors/active-runner.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import { fallbackRowKey, seatFallback, type FallbackRow } from '../../core/crew/fallback.js';
import { crossLabVerdict, resolveLab, type CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import type { CrewRow } from '../../core/crew/rows.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import {
  fallbackPickerOverlayFor,
  seatAxisFocus,
  seatPickerOverlayFor,
  toolRowFocus,
} from '../../core/navigation/types.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../../core/providers/automatic-model.js';
import { seatConfiguredEffort } from '../../core/runners/capabilities.js';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import {
  formatConfigSaveSuccess,
  reportConfigSaveFailure,
} from '../../stores/project/save-feedback.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';

export type CrewActivationTarget =
  | Readonly<{ kind: 'crew'; row: CrewRow }>
  | Readonly<{ kind: 'preset'; preset: CrewPreset }>;

export type CrewActivation =
  | Readonly<{ kind: 'opened' }>
  | Readonly<{ kind: 'applied'; config: Config }>;

export function crewVerdict(rows: readonly CrewRow[]): CrewLabVerdict | undefined {
  const seatRunner = (id: CrewSeatId) => {
    for (const row of rows) if (row.id === id) return row.seat.runner;
    return undefined;
  };
  const build = seatRunner('build');
  const review = seatRunner('review');
  if (build === undefined || review === undefined) return undefined;
  return crossLabVerdict({ build: resolveLab(build), review: resolveLab(review) });
}

function keepSeatFallback(
  preset: Config['implementer'],
  existing: RunnerConfig,
): Config['implementer'];
function keepSeatFallback(preset: Config['planner'], existing: RunnerConfig): Config['planner'];
function keepSeatFallback(preset: RunnerConfig, existing: RunnerConfig): RunnerConfig {
  const { fallback: _fallback, ...runner } = preset;
  return existing.fallback === undefined ? runner : { ...runner, fallback: existing.fallback };
}

function withPresetSeats(config: Config, preset: CrewPreset): Config {
  const seats = preset.seats;
  const withPlanner = updateActiveRunner({
    config,
    role: 'planner',
    updater: (existing) => keepSeatFallback(seats.planner, existing),
  });
  const withImplementer = updateActiveRunner({
    config: withPlanner,
    role: 'implementer',
    updater: (existing) => keepSeatFallback(seats.implementer, existing),
  });
  const reviewer = seats.reviewer;
  if (reviewer === undefined) return clearReviewerSeat(withImplementer);
  return updateActiveRunner({
    config: withImplementer,
    role: 'reviewer',
    updater: (existing) => keepSeatFallback(reviewer, existing),
  });
}

async function persistCrew(config: Config, label: string): Promise<void> {
  const result = await configStore.save(config);
  if (reportConfigSaveFailure(result)) return;
  feedbackStore.setMessage(formatConfigSaveSuccess(label));
}

function openCrewRow(row: CrewRow, config: Config): CrewActivation {
  const seatId = row.id;
  const runner = readActiveRunner({ config, role: CREW_SEAT_ROLES[seatId] });
  const model = normalizeConfiguredModel(
    runner.model,
    runner.kind === 'cli' ? runner.tool : undefined,
  );
  if (model !== undefined && model !== AUTOMATIC_MODEL) {
    const effort = seatConfiguredEffort({ runner, role: CREW_SEAT_ROLES[seatId] });
    pickerViewStore.expand(model, undefined, effort);
  }
  overlayStore.open(seatPickerOverlayFor(CREW_SEAT_ROLES[seatId]), seatAxisFocus(seatId));
  return { kind: 'opened' };
}

export function fallbackActivate(input: Readonly<{ row: FallbackRow; config: Config }>): void {
  overlayStore.setFocus(fallbackRowKey(input.row));
  const role = CREW_SEAT_ROLES[input.row.id];
  const fallback = seatFallback(input.config, role);
  const model = normalizeConfiguredModel(fallback?.model, fallback?.tool);
  if (fallback !== undefined && model !== undefined && model !== AUTOMATIC_MODEL) {
    pickerViewStore.expand(model, undefined, fallback.effort ?? fallback.variant ?? null);
    overlayStore.open(fallbackPickerOverlayFor(role), seatAxisFocus(input.row.id));
    return;
  }
  overlayStore.open(
    fallbackPickerOverlayFor(role),
    fallback === undefined ? undefined : toolRowFocus(fallback.tool),
  );
}

export function crewActivate(
  input: Readonly<{ target: CrewActivationTarget; config: Config }>,
): CrewActivation {
  const { target } = input;
  if (target.kind === 'crew') return openCrewRow(target.row, input.config);

  const config = withPresetSeats(input.config, target.preset);
  void persistCrew(config, target.preset.label);
  return { kind: 'applied', config };
}
