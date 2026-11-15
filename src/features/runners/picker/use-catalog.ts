import { useState } from 'react';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import {
  type RunnerConfig,
  getRunnerCommand,
} from '../../../core/config/accessors/runner-config.js';
import {
  CREW_SEAT_IDS,
  CREW_SEAT_LABELS,
  formatSeatIdentity,
} from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { SavedCatalog } from '../../../core/discovery/catalog-read-merge.js';
import type { CliProviderAuth } from '../../../core/discovery/detection/auth.js';
import { toolRowFocusTool, seatAxisFocusSeat } from '../../../core/navigation/types.js';
import {
  normalizeConfiguredModel,
  AUTOMATIC_MODEL,
} from '../../../core/providers/automatic-model.js';
import { CLI_TOOL_IDS, hasNativeCliCatalog } from '../../../core/runners/cli-tool/catalog.js';
import {
  type SeatPickerRole,
  type PickerSlot,
  seatPickerLane,
  PICKER_ROLE_SEAT_IDS,
} from '../../../core/runners/seat-roles.js';
import { resolveSeatDisplayName } from '../../../engine/providers/model/display-names.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { configStore } from '../../../stores/project/config.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { useStores } from '../../../stores/use-many.js';
import { includes } from '../../../utils/type-guards.js';
import {
  type PickerModelCounts,
  readPickerRunner,
  isCurrentRunner,
  buildRightModels,
  countModelOptions,
} from '../model-catalog/catalog.js';
import {
  type PickerOption,
  buildPickerOptions,
  assemblePickerDescriptors,
} from '../model-catalog/options.js';
import { buildRightRows } from '../model-catalog/rows.js';
import type { RightRow, CatalogLane } from '../model-catalog/types.js';
import type { ModelCatalogDiagnostic } from './catalog-guidance.js';
import {
  buildLeftItems,
  toolIdOf,
  laneOf,
  rowIndexForEffortAxis,
  rowIndexForModel,
  countModelRows,
} from './left-items.js';
import { usePickerProfile } from './profile.js';

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
  savedRunner: RunnerConfig | undefined;
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
  /** The highlighted tool's own model listing, read against a route with its credential listing. */
  toolCatalog: SavedCatalog | null | undefined;
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

/**
 * A `cli` tool outside the native-catalog set cannot enumerate its models, so
 * the honest answer is "unsupported" rather than silence.
 */
function deriveCatalogDiagnostic(
  item: PickerOption | undefined,
  staleRows: number,
): ModelCatalogDiagnostic | undefined {
  if (item === undefined || item.kind !== 'cli' || !includes(CLI_TOOL_IDS, item.id)) {
    return undefined;
  }
  const tool = item.id;
  if (!hasNativeCliCatalog(tool)) return { kind: 'unsupported' };
  const runtime = modelCacheStore.getCliCatalogRuntime({ tool });
  if (runtime === null || runtime === undefined) return { kind: 'not-probed' };
  if (runtime.failure === undefined) return undefined;
  if (runtime.failure === 'not-run' && staleRows > 0) return { kind: 'not-run-retained' };
  if (runtime.failure === 'command-failed') {
    return { kind: 'probe-failed', failure: runtime.failure, cause: runtime.failureCause };
  }
  return { kind: 'probe-failed', failure: runtime.failure };
}

export function usePickerCatalog(
  role: SeatPickerRole,
  slot: PickerSlot,
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
  const profile = usePickerProfile();

  const [{ cliTools, providers, providerOutcomes, cliCatalogOutcomes, refresh }] =
    useStores(detectionStore);

  const [uncontrolledItemId, setUncontrolledItemId] = useState<string | null>(null);
  const [previousFocus, setPreviousFocus] = useState(focus);
  if (previousFocus !== focus) {
    setPreviousFocus(focus);
    setUncontrolledItemId(null);
  }

  const runnerConfig = readPickerRunner(config, lane, slot, profile);

  const rawItems = buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    {
      cliTools,
      providers,
      providerOutcomes,
      cliCatalog: (tool) => modelCacheStore.getCliCatalogRuntime({ tool }),
    },
    undefined,
  );
  const items = buildLeftItems({
    role,
    slot,
    rawItems,
    config,
    runner: runnerConfig,
  });

  const configItemIndex = items.findIndex((item) => item.isCurrent);
  const configuredItem = configItemIndex >= 0 ? items[configItemIndex] : undefined;
  const preservedIndex = Math.min(preservedLeftIndex, Math.max(0, items.length - 1));
  const focusedTool = toolRowFocusTool(focus);
  const focusedIndex =
    focusedTool === undefined ? -1 : items.findIndex((item) => item.id === focusedTool);
  const initialLeftIdx =
    focusedIndex >= 0 ? focusedIndex : configItemIndex >= 0 ? configItemIndex : preservedIndex;

  const seatAxisSeat = seatAxisFocusSeat(focus);
  const seatAxisFocused =
    seatAxisSeat !== undefined &&
    includes(CREW_SEAT_IDS, seatAxisSeat) &&
    CREW_SEAT_ROLES[seatAxisSeat] === lane;

  // The custom list belongs to the tool of the seat's runner, inherited or not: offered
  // on a tool the cursor is merely visiting, a pick, an add or a Ctrl+D would act on
  // ids that tool cannot run.
  const customModelsOf = (item: PickerOption | undefined): string[] =>
    slot === 'seat' && item !== undefined && isCurrentRunner(item, runnerConfig)
      ? (runnerConfig?.customModels ?? [])
      : [];

  const defaultItemId = items[initialLeftIdx]?.id ?? items[0]?.id;
  const ownedItemId =
    selectedItemId !== undefined && selectedItemId !== null
      ? selectedItemId
      : (uncontrolledItemId ?? defaultItemId);
  const currentItem = items.find((item) => item.id === ownedItemId) ?? items[0];

  // Both spellings of automatic selection — `auto` and model absence — collapse
  // onto the single synthesized Auto row, so there is one highlighted identity.
  const configuredModel = normalizeConfiguredModel(
    runnerConfig?.model,
    runnerConfig?.kind === 'cli' ? runnerConfig.tool : undefined,
  );
  const persistedModel =
    configuredModel ??
    (configuredItem?.modelCapability.allowsAutomatic ? AUTOMATIC_MODEL : undefined);
  const authOf = (item: PickerOption | undefined): CliProviderAuth | undefined => {
    const tool = toolIdOf(item);
    return item?.providerDependent === true && tool !== undefined
      ? cliTools.find((detection) => detection.tool === tool)?.providerAuth
      : undefined;
  };
  const toolCatalogOf = (item: PickerOption | undefined): SavedCatalog | null | undefined => {
    const tool = toolIdOf(item);
    return item?.providerDependent === true && tool !== undefined
      ? modelCacheStore.getCliCatalogRuntime({ tool })
      : undefined;
  };

  const providerAuth = authOf(currentItem);

  // Read the scoped catalog lane so a catalog-only publication rerenders this
  // picker; actual role-aware lookup remains inside modelCacheStore.
  void cliCatalogOutcomes;
  const catalogLane = laneOf(refresh.modelsDev);

  const catalogFor = (item: PickerOption | undefined) => {
    const auth = authOf(item);
    const toolCatalog = toolCatalogOf(item);
    const tool = toolIdOf(item);
    const customModels = customModelsOf(item);
    const models = buildRightModels({
      role: lane,
      customModels,
      currentItem: item,
      cache: modelCacheStore,
      persistedModel,
      tool,
      providerAuth: auth,
      catalog: toolCatalog,
      browseCatalog,
    });
    return {
      models,
      rows: buildRightRows({
        models,
        expandedModelId,
        providerAuth: auth,
        catalog: toolCatalog,
        tool,
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
  const seatAxisIndex = seatAxisFocused
    ? rowIndexForEffortAxis(rightRows, persistedModel, optionDraftId)
    : -1;
  const modelCounts = countModelOptions(rightModels);
  const catalogDiagnostic =
    modelCounts.confirmed > 0 ? undefined : deriveCatalogDiagnostic(currentItem, modelCounts.stale);

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
  // A picker opened on another tool's row has no persisted model of its own, so the
  // drafted model is where its right column lands; the current tool still lands on
  // the model the seat runs.
  const entryModel = isCurrentTool ? currentModel : (expandedModelId ?? undefined);
  const currentCommand = runnerConfig === undefined ? undefined : getRunnerCommand(runnerConfig);
  const currentCommandKind =
    runnerConfig?.kind === 'shell' || runnerConfig?.kind === 'agent'
      ? runnerConfig.kind
      : undefined;

  return {
    items,
    rightRows,
    currentItem,
    selectedItemId: ownedItemId,
    initialLeftIdx,
    initialRightIndex: seatAxisIndex >= 0 ? seatAxisIndex : rowIndexForModel(rightRows, entryModel),
    resolveRightIndex,
    focusModels: focusedIndex >= 0 || seatAxisFocused,
    roleLabel: CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]],
    plannerIdentity: (() => {
      const plannerRunner = readActiveRunner({ config, role: 'planner' });
      const displayName = resolveSeatDisplayName(plannerRunner, 'planner', modelCacheStore);
      return formatSeatIdentity({ seat: plannerRunner, displayName });
    })(),
    savedRunner: runnerConfig,
    currentModel,
    persistedModel,
    modelCounts,
    catalogDiagnostic,
    catalogLane,
    providerAuth,
    toolCatalog: toolCatalogOf(currentItem),
    currentCommand,
    currentCommandKind,
    customModels: customModelsOf(currentItem),
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
