import { useState } from 'react';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { detectionStore } from '../../stores/project/detection.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { useStores } from '../../stores/use-stores.js';
import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import { CREW_SEAT_IDS, CREW_SEAT_LABELS, formatSeatIdentity } from '../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { getRunnerCommand } from '../../core/config/accessors/runner-config.js';
import {
  AUTOMATIC_MODEL,
  isAutoCheapestModel,
  isAutomaticModel,
  normalizeConfiguredModel,
} from '../../core/providers/automatic-model.js';
import { CLI_TOOL_IDS, hasNativeCliCatalog } from '../../core/runners/cli-tool-catalog.js';
import {
  PICKER_ROLE_SEAT_IDS,
  seatPickerLane,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import type { CliProviderAuth } from '../../core/discovery/detection.js';
import { seatAxisFocusSeat } from '../../core/navigation/types.js';
import { providerOracleCommand } from '../../engine/runners/cli-tools/provider-oracle.js';
import { includes } from '../../utils/type-guards.js';
import type { ModelCatalogDiagnostic } from './picker-format.js';
import {
  buildRightModels,
  countModelOptions,
  isCurrentConfig,
  modelRowMatchesId,
  type PickerModelCounts,
} from './model-catalog/catalog.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  inheritPlannerOption,
  type PickerOption,
} from './model-catalog/options.js';
import { buildRightRows, type CatalogLane, type RightRow } from './model-catalog/rows.js';
import { inheritsPlannerSeat } from './config-transforms.js';
import type { Config } from '../../core/schemas/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import type { DiscoverySourceRefresh } from '../../stores/discovery/model-cache/types.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';

export interface PickerCatalog {
  items: PickerOption[];
  rightRows: RightRow[];
  currentItem: PickerOption | undefined;
  selectedItemId: string | undefined;
  initialLeftIdx: number;
  /** Index into `rightRows` of the persisted model, or the first row. */
  initialRightIndex: number;
  /** The same entry row for a left item the cursor is moving onto. */
  resolveRightIndex: (item: PickerOption | undefined) => number | undefined;
  focusModels: boolean;
  roleLabel: string;
  /** What the planner actually runs; the terminal panes name it. */
  plannerIdentity: string;
  currentModel: string | undefined;
  persistedModel: string | undefined;
  /** Membership buckets for picker rendering and diagnostics. */
  modelCounts: PickerModelCounts;
  /** Why the native CLI catalog holds no confirmed models; undefined when confirmed or inapplicable. */
  catalogDiagnostic: ModelCatalogDiagnostic | undefined;
  /** Whether the catalog fetch that feeds suggestion rows has landed. */
  catalogLane: CatalogLane;
  /** The highlighted tool's own credential listing, tri-state at the source. */
  providerAuth: CliProviderAuth | undefined;
  /** The tool can enumerate its provider sign-ins, so route rows may claim one. */
  hasOracle: boolean;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
  customModels: string[];
  /** Live discovery lane state: cold means no readiness result has ever landed. */
  discovery: Readonly<{ cold: boolean; refreshing: boolean }>;
  /** The user asked to see the wider catalog after a recovery row. */
  browseCatalog: boolean;
  /** The in-flight axis value inside the expanded model, committed only on Enter. */
  effortDraft: string | null;
  /** Rows the tool's own listing produced, after family folding; the Auto row and custom rows are not among them. */
  modelRowCount: number;
  /** The in-flight option-family draft; the byline spells the id it names. */
  optionDraftId: string | null;
  setCurrentItem: (item: PickerOption) => void;
}

const FOCUS_TOOL_PREFIX = 'tool:';

function laneOf(source: DiscoverySourceRefresh): CatalogLane {
  if (source.refreshing || source.outcome === 'uninitialized') return 'pending';
  if (source.outcome === 'failed') return 'failed';
  return 'ready';
}

/**
 * A `cli` tool outside the native-catalog set cannot enumerate its models, so
 * the honest answer is "unsupported" rather than silence.
 */
function deriveCatalogDiagnostic(
  item: PickerOption | undefined,
): ModelCatalogDiagnostic | undefined {
  if (item === undefined || item.kind !== 'cli' || !includes(CLI_TOOL_IDS, item.id)) {
    return undefined;
  }
  const tool = item.id;
  if (!hasNativeCliCatalog(tool)) return { kind: 'unsupported' };
  const runtime = modelCacheStore.getCliCatalogRuntime({ tool });
  if (runtime === null || runtime === undefined) return { kind: 'not-probed' };
  if (runtime.failure === undefined) return undefined;
  return { kind: 'probe-failed', failure: runtime.failure };
}

function toolIdOf(item: PickerOption | undefined): (typeof CLI_TOOL_IDS)[number] | undefined {
  return item !== undefined && includes(CLI_TOOL_IDS, item.id) ? item.id : undefined;
}

function rowIndexForModel(rows: readonly RightRow[], persistedModel: string | undefined): number {
  if (persistedModel !== undefined) {
    const exact = rows.findIndex(
      (row) => row.kind === 'model' && modelRowMatchesId(row.model, persistedModel),
    );
    if (exact >= 0) return exact;
  }
  return 0;
}

/** The models the tool's own listing produced: an Auto row is an affordance, so is price routing, and a custom row is the user's. */
function countModelRows(rows: readonly RightRow[]): number {
  return rows.filter(
    (row) =>
      row.kind === 'model' &&
      row.provenance !== 'Custom' &&
      !isAutomaticModel(row.model.id) &&
      !isAutoCheapestModel(row.model.id),
  ).length;
}

function rowIndexForEffortAxis(rows: readonly RightRow[]): number {
  return rows.findIndex((row) => row.kind === 'axis' && row.axis === 'effort');
}

function buildLeftItems(input: {
  role: SeatPickerRole;
  rawItems: PickerOption[];
  config: Config;
}): PickerOption[] {
  const { role, rawItems, config } = input;
  const lane = seatPickerLane(role);
  // An inherited review seat has no tool of its own: flagging the planner's row
  // as current would make Enter on the pre-selected row fork the seat silently.
  // The inherit row stands in for it, and stays offered once the seat is forked
  // so the fork is reversible.
  const inherited = inheritsPlannerSeat(config, lane);
  const configuredItems: PickerOption[] = rawItems.map((item) => ({
    ...item,
    isCurrent: !inherited && isCurrentConfig(item, config, lane),
  }));
  if (role !== 'reviewer') return configuredItems;
  const plannerItem = rawItems.find((item) => isCurrentConfig(item, config, 'planner'));
  if (plannerItem === undefined) return configuredItems;
  return [inheritPlannerOption({ planner: plannerItem, isCurrent: inherited }), ...configuredItems];
}

export function usePickerCatalog(
  role: SeatPickerRole,
  preservedLeftIndex: number,
  selectedItemId?: string | null,
): PickerCatalog {
  const config = configStore.useConfig();
  const lane = seatPickerLane(role);
  const focus = overlayStore.use((s) => s.focus);
  const expandedModelId = pickerViewStore.use((s) => s.expandedModelId);
  const optionDraftId = pickerViewStore.use((s) => s.optionDraftId);
  const effortDraft = pickerViewStore.use((s) => s.effortDraft);
  const browseCatalog = pickerViewStore.use((s) => s.browseCatalog);

  const [{ cliTools, providers, providerOutcomes, cliCatalogOutcomes, refresh }] =
    useStores(detectionStore);

  const [uncontrolledItemId, setUncontrolledItemId] = useState<string | null>(null);

  const runnerConfig = readActiveRunner({ config, role: lane });

  const rawItems = buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    { cliTools, providers, providerOutcomes },
    undefined,
  );
  const items = buildLeftItems({
    role,
    rawItems,
    config,
  });

  const configItemIndex = items.findIndex((item) => item.isCurrent);
  const configuredItem = configItemIndex >= 0 ? items[configItemIndex] : undefined;
  const preservedIndex = Math.min(preservedLeftIndex, Math.max(0, items.length - 1));
  const focusedTool = focus?.startsWith(FOCUS_TOOL_PREFIX)
    ? focus.slice(FOCUS_TOOL_PREFIX.length)
    : undefined;
  const focusedIndex =
    focusedTool === undefined ? -1 : items.findIndex((item) => item.id === focusedTool);
  const initialLeftIdx =
    focusedIndex >= 0 ? focusedIndex : configItemIndex >= 0 ? configItemIndex : preservedIndex;

  const seatAxisSeat = seatAxisFocusSeat(focus);
  const seatAxisFocused =
    seatAxisSeat !== undefined &&
    includes(CREW_SEAT_IDS, seatAxisSeat) &&
    CREW_SEAT_ROLES[seatAxisSeat] === lane;

  const customModels = runnerConfig.customModels ?? [];

  const defaultItemId = items[initialLeftIdx]?.id ?? items[0]?.id;
  const ownedItemId =
    selectedItemId !== undefined && selectedItemId !== null
      ? selectedItemId
      : (uncontrolledItemId ?? defaultItemId);
  const currentItem = items.find((item) => item.id === ownedItemId) ?? items[0];

  // Both spellings of automatic selection — `auto` and model absence — collapse
  // onto the single synthesized Auto row, so there is one highlighted identity.
  const configuredModel = normalizeConfiguredModel(runnerConfig.model);
  const persistedModel =
    configuredModel ??
    (configuredItem?.modelCapability.allowsAutomatic ? AUTOMATIC_MODEL : undefined);
  const authOf = (item: PickerOption | undefined): CliProviderAuth | undefined => {
    const tool = toolIdOf(item);
    return item?.providerDependent === true && tool !== undefined
      ? cliTools.find((detection) => detection.tool === tool)?.providerAuth
      : undefined;
  };

  const toolId = toolIdOf(currentItem);
  const providerAuth = authOf(currentItem);
  const hasOracle = toolId !== undefined && providerOracleCommand(toolId) !== undefined;

  // Read the scoped catalog lane so a catalog-only publication rerenders this
  // picker; actual role-aware lookup remains inside modelCacheStore.
  void cliCatalogOutcomes;
  const catalogLane = laneOf(refresh.modelsDev);

  const catalogFor = (item: PickerOption | undefined) => {
    const auth = authOf(item);
    const tool = toolIdOf(item);
    const models = buildRightModels({
      role: lane,
      customModels,
      currentItem: item,
      cache: modelCacheStore,
      persistedModel,
      providerAuth: auth,
      browseCatalog,
    });
    return {
      models,
      rows: buildRightRows({
        models,
        expandedModelId,
        providerAuth: auth,
        hasOracle: tool !== undefined && providerOracleCommand(tool) !== undefined,
        catalogLane,
        persistedModel,
        customModels,
        browseCatalog,
        optionDraftId,
        effortDraft,
      }),
    };
  };

  const { models: rightModels, rows: rightRows } = catalogFor(currentItem);
  const seatAxisIndex = seatAxisFocused ? rowIndexForEffortAxis(rightRows) : -1;
  const modelCounts = countModelOptions(rightModels);
  const catalogDiagnostic =
    modelCounts.confirmed > 0 ? undefined : deriveCatalogDiagnostic(currentItem);

  // Every reset of the model column must land on the configured model, or
  // moving the tool cursor and confirming silently rewrites it with the pinned
  // Auto row that sits at index 0.
  const resolveRightIndex = (item: PickerOption | undefined): number | undefined => {
    if (item === undefined || item.isCurrent !== true || persistedModel === undefined) {
      return undefined;
    }
    if (item.id === currentItem?.id) return rowIndexForModel(rightRows, persistedModel);
    return rowIndexForModel(catalogFor(item).rows, persistedModel);
  };

  const discovery = {
    cold: refresh.readiness.fetchedAt === null,
    refreshing:
      refresh.readiness.refreshing || refresh.modelsDev.refreshing || refresh.cliModels.refreshing,
  };

  const isCurrentTool = currentItem?.isCurrent ?? false;
  const currentModel = isCurrentTool ? persistedModel : undefined;
  const currentCommand = getRunnerCommand(runnerConfig);
  const currentCommandKind =
    runnerConfig.kind === 'shell' || runnerConfig.kind === 'agent' ? runnerConfig.kind : undefined;

  return {
    items,
    rightRows,
    currentItem,
    selectedItemId: ownedItemId,
    initialLeftIdx,
    initialRightIndex:
      seatAxisIndex >= 0 ? seatAxisIndex : rowIndexForModel(rightRows, currentModel),
    resolveRightIndex,
    focusModels: focusedIndex >= 0 || seatAxisFocused,
    roleLabel: CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]],
    plannerIdentity: (() => {
      const plannerRunner = readActiveRunner({ config, role: 'planner' });
      const displayName = resolveSeatDisplayName(plannerRunner, 'planner', modelCacheStore);
      return formatSeatIdentity(plannerRunner, displayName);
    })(),
    currentModel,
    persistedModel,
    modelCounts,
    catalogDiagnostic,
    catalogLane,
    providerAuth,
    hasOracle,
    currentCommand,
    currentCommandKind,
    customModels,
    discovery,
    browseCatalog,
    effortDraft,
    modelRowCount: countModelRows(rightRows),
    optionDraftId,
    setCurrentItem: (item) => {
      if (selectedItemId !== undefined) return;
      setUncontrolledItemId(item.id);
    },
  };
}
