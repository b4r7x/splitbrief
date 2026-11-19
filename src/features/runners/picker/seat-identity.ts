import { formatSeatIdentity } from '../../../core/crew/identity.js';
import type { SeatChangePoint } from '../../../core/crew/seats.js';
import { selectSeatChangePoint } from '../../../core/run-view/briefs.js';
import { CLI_TOOL_IDS } from '../../../core/runners/cli-tool/catalog.js';
import { routeAuthState } from '../../../core/runners/route-auth.js';
import type { ActiveRunnerRole, PickerSlot } from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import { seatIdentityChanges } from '../../../core/state/seats/changes.js';
import { seatIdentitiesFromConfig } from '../../../core/state/seats/record.js';
import { resolveSeatDisplayName } from '../../../engine/providers/model/display-names.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { preparationStore } from '../../../stores/navigation/preparation.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { takesSeatAtBoundary, stopStore } from '../../../stores/workflow/stop.js';
import { error } from '../../../utils/error.js';
import { includes } from '../../../utils/type-guards.js';
import { readPickerRunner } from '../model-catalog/catalog.js';
import type { PickerOption, RunnerPickerOption } from '../model-catalog/options.js';
import { effortLadderFor } from '../model-catalog/axis-rows.js';
import type { RightRow } from '../model-catalog/types.js';
import { formatNeedsSignInSaveFeedback } from './labels.js';

/**
 * Where a seat saved under a run this process drives takes over: at a brief or review boundary,
 * where the run re-prepares from the saved config. The run loop marks in its config subscription,
 * before the save returns, whether a saved seat still waits; a save back to the seat of the run
 * leaves none. A start still checking its tools runs on the config it read first, so its first
 * boundary takes the seat.
 */
export function runningSeatChangePoint(before: Config, after: Config): SeatChangePoint | undefined {
  if (
    seatIdentityChanges(seatIdentitiesFromConfig(before), seatIdentitiesFromConfig(after))
      .length === 0
  ) {
    return undefined;
  }
  const preparation = preparationStore.get();
  if (preparation.kind === 'checking' && preparation.origin === 'start') {
    return { after: 'next-brief' };
  }
  const route = routerStore.get();
  const view = runViewStore.get();
  return route.screen === 'workflow' &&
    route.execution.kind === 'local' &&
    takesSeatAtBoundary() &&
    stopStore.get().seatChange
    ? selectSeatChangePoint(view.briefs, view.phase)
    : undefined;
}

/**
 * The seat a save kept, in the words the crew rows and the sidebar show for it: the model's
 * catalog label and every axis the saved block carries, so a level the tool cannot spell, which
 * the commit dropped, is never announced.
 */
export function savedSeatIdentity(
  saved: Config,
  role: ActiveRunnerRole,
  slot: PickerSlot,
  profile: string | undefined,
): string {
  const runner = readPickerRunner(saved, role, slot, profile);
  if (runner === undefined) {
    throw error('picker-invalid-fallback', 'Saved fallback has no CLI runner', { role });
  }
  return formatSeatIdentity({
    seat: runner,
    displayName: resolveSeatDisplayName(runner, role, modelCacheStore),
  });
}

/** The seat rows that can carry a model; the terminal rows never reach a commit. */
export function runnerItemOf(item: PickerOption | undefined): RunnerPickerOption | undefined {
  if (item === undefined) return undefined;
  if (
    item.kind === 'custom-command' ||
    item.kind === 'configured-command' ||
    item.kind === 'inherit-planner' ||
    item.kind === 'no-fallback' ||
    item.kind === 'review-none'
  ) {
    return undefined;
  }
  return item;
}

/**
 * The provider honesty note for a saved model, a route or a custom id, read the
 * way its picker row reads it: only a route that needs a sign-in names the login
 * command that unblocks the saved selection.
 */
export function needsSignInVariantNote(
  item: RunnerPickerOption,
  fullId: string,
): string | undefined {
  const toolId = includes(CLI_TOOL_IDS, item.id) ? item.id : undefined;
  if (toolId === undefined) return undefined;
  const auth = routeAuthState({
    tool: toolId,
    model: fullId,
    providerAuth: detectionStore.get().cliTools.find((d) => d.tool === toolId)?.providerAuth,
    catalog: modelCacheStore.getCliCatalogRuntime({ tool: toolId }),
  });
  if (auth.kind === 'needs-sign-in' || (auth.kind === 'unknown' && auth.reason === 'empty')) {
    return formatNeedsSignInSaveFeedback({ tool: auth.tool, provider: auth.provider });
  }
  return undefined;
}

export type RowEffortLadder = Readonly<{
  effortChoices: readonly string[];
  effortChoicesFromFloor?: boolean | undefined;
}>;

/** The ladder the row published for this id; an empty one is unknown, never a reason to clear. */
export function rowEffortLadder(
  rows: readonly RightRow[],
  fullId: string,
): RowEffortLadder | undefined {
  for (const row of rows) {
    if (row.kind === 'action') continue;
    const owns =
      row.model.id === fullId ||
      (row.model.variants ?? []).some((variant) => variant.fullId === fullId);
    if (!owns) continue;
    const choices = effortLadderFor(row.model, fullId);
    if (choices.length > 0) {
      return { effortChoices: choices, effortChoicesFromFloor: row.model.effortChoicesFromFloor };
    }
  }
  return undefined;
}
