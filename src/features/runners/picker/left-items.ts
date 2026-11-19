import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { isCustomCommandRunner } from '../../../core/config/custom-commands/tuple.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { CLI_TOOL_IDS } from '../../../core/runners/cli-tool/catalog.js';
import {
  type SeatPickerRole,
  type PickerSlot,
  seatPickerLane,
} from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import type { DiscoverySourceRefresh } from '../../../stores/discovery/model-cache/types.js';
import { includes } from '../../../utils/type-guards.js';
import { modelRowMatchesId, isCurrentRunner } from '../model-catalog/catalog.js';
import { routeDraftOf } from '../model-catalog/option-axis.js';
import {
  type PickerOption,
  configuredCommandOption,
  noFallbackOption,
  reviewNoneOption,
  inheritPlannerOption,
} from '../model-catalog/options.js';
import type { CatalogLane, RightRow } from '../model-catalog/types.js';

export function laneOf(source: DiscoverySourceRefresh): CatalogLane {
  if (source.refreshing || source.outcome === 'uninitialized') return 'pending';
  if (source.outcome === 'failed') return 'failed';
  return 'ready';
}

export function toolIdOf(
  item: PickerOption | undefined,
): (typeof CLI_TOOL_IDS)[number] | undefined {
  return item !== undefined && includes(CLI_TOOL_IDS, item.id) ? item.id : undefined;
}

export function rowIndexForModel(
  rows: readonly RightRow[],
  persistedModel: string | undefined,
): number {
  if (persistedModel !== undefined) {
    const exact = rows.findIndex(
      (row) => row.kind === 'model' && modelRowMatchesId(row.model, persistedModel),
    );
    if (exact >= 0) return exact;
  }
  return 0;
}

/** The models the tool's own listing produced: an Auto row is an affordance and a custom row is the user's. */
export function countModelRows(rows: readonly RightRow[]): number {
  return rows.filter(
    (row) => row.kind === 'model' && row.provenance !== 'Custom' && !isAutomaticModel(row.model.id),
  ).length;
}

/** The effort row on which Enter saves the seat's own model: another route's row would move the seat. */
export function rowIndexForEffortAxis(
  rows: readonly RightRow[],
  persistedModel: string | undefined,
  optionDraftId: string | null,
): number {
  return rows.findIndex(
    (row) =>
      row.kind === 'axis' &&
      row.axis === 'effort' &&
      routeDraftOf(row.model, row.providerPrefix, optionDraftId) === persistedModel,
  );
}

export function buildLeftItems(input: {
  role: SeatPickerRole;
  slot: PickerSlot;
  rawItems: PickerOption[];
  config: Config;
  runner: RunnerConfig | undefined;
}): PickerOption[] {
  const { role, slot, rawItems, config, runner } = input;
  const lane = seatPickerLane(role);
  if (slot === 'fallback') {
    return [
      noFallbackOption({ isCurrent: runner === undefined }),
      ...rawItems
        .filter((item) => item.kind === 'cli')
        .map((item) => ({ ...item, isCurrent: isCurrentRunner(item, runner) })),
    ];
  }
  // A review seat that inherits or is None has no tool of its own: flagging the planner's row
  // as current would make Enter on the pre-selected row fork the seat silently.
  // The inherit and None rows stand in for it, and stay offered once the seat is forked
  // so the fork is reversible.
  const source = lane === 'reviewer' ? resolveReviewerRunner(config).source : 'configured';
  const configuredItems: PickerOption[] = rawItems.map((item) => ({
    ...item,
    isCurrent: source === 'configured' && isCurrentRunner(item, runner),
  }));
  if (source === 'configured' && runner !== undefined && isCustomCommandRunner(runner)) {
    configuredItems.unshift(configuredCommandOption(runner, lane));
  }
  if (role !== 'reviewer') return configuredItems;
  const none = reviewNoneOption({ isCurrent: source === 'none' });
  const { planner } = config;
  const plannerItem = isCustomCommandRunner(planner)
    ? planner.kind
    : rawItems.find((item) => isCurrentRunner(item, planner));
  if (plannerItem === undefined) return [none, ...configuredItems];
  return [
    inheritPlannerOption({ planner: plannerItem, isCurrent: source === 'planner' }),
    none,
    ...configuredItems,
  ];
}
