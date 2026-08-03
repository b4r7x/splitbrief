import { useState } from 'react';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { detectionStore } from '../../stores/project/detection.js';
import { useStores } from '../../stores/use-stores.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import {
  getRunnerCommand,
  getRunnerDisplayName,
} from '../../core/config/accessors/runner-config.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../../core/providers/automatic-model.js';
import { NATIVE_CLI_CATALOG_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import { includes } from '../../utils/type-guards.js';
import type { ModelCatalogDiagnostic } from './picker-format.js';
import {
  buildRightModels,
  countModelOptions,
  isCurrentConfig,
  type PickerModelCounts,
} from './model-catalog/catalog.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type PickerOption,
} from './model-catalog/options.js';
import type { ModelOption } from './model-catalog/recency.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';

export interface PickerCatalog {
  items: PickerOption[];
  rightModels: ModelOption[];
  currentItem: PickerOption | undefined;
  selectedItemId: string | undefined;
  initialLeftIdx: number;
  focusModels: boolean;
  roleLabel: string;
  currentModel: string | undefined;
  persistedModel: string | undefined;
  /** Confirmed runtime models only; stale/suggested rows are excluded. */
  discoveredModelCount: number;
  /** Membership buckets for picker rendering and diagnostics. */
  modelCounts: PickerModelCounts;
  /** Why the native CLI catalog holds no confirmed models; undefined when confirmed or inapplicable. */
  catalogDiagnostic: ModelCatalogDiagnostic | undefined;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
  customModels: string[];
  setCurrentItem: (item: PickerOption) => void;
}

function deriveCatalogDiagnostic(
  role: 'planner' | 'implementer',
  item: PickerOption | undefined,
): ModelCatalogDiagnostic | undefined {
  if (item === undefined || !includes(NATIVE_CLI_CATALOG_TOOL_IDS, item.id)) return undefined;
  const runtime = modelCacheStore.getScopedCliCatalogRuntime({ role, tool: item.id });
  if (runtime === null || runtime === undefined) return { kind: 'not-probed' };
  if (runtime.failure === undefined) return undefined;
  return { kind: 'probe-failed', failure: runtime.failure };
}

export function usePickerCatalog(
  role: 'planner' | 'implementer',
  preservedLeftIndex: number,
  selectedItemId?: string | null,
): PickerCatalog {
  const isPlanner = role === 'planner';
  const config = configStore.useConfig();
  const focusModels = overlayStore.use((s) => s.focus) === 'models';

  const [{ cliTools, providers, providerOutcomes, cliCatalogOutcomes }] = useStores(detectionStore);

  const [uncontrolledItemId, setUncontrolledItemId] = useState<string | null>(null);

  const runnerConfig = isPlanner
    ? config.planner
    : resolveImplementerProfiles(config).defaultProfile.config;

  const rawItems = buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    { cliTools, providers, providerOutcomes },
    undefined,
    { activeRunnerId: getRunnerDisplayName(runnerConfig) },
  );
  const items: PickerOption[] = rawItems.map((item) => ({
    ...item,
    isCurrent: isCurrentConfig(item, config, role),
  }));

  const configItemIndex = items.findIndex((item) => item.isCurrent);
  const configuredItem = configItemIndex >= 0 ? items[configItemIndex] : undefined;
  const preservedIndex = Math.min(preservedLeftIndex, Math.max(0, items.length - 1));
  const initialLeftIdx = configItemIndex >= 0 ? configItemIndex : preservedIndex;

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
  const providerAuthFacts =
    currentItem?.providerDependent === true
      ? cliTools.find((detection) => detection.tool === currentItem.id)?.providerAuth
      : undefined;

  const rightModels = buildRightModels({
    isPlanner,
    role,
    customModels,
    currentItem,
    cache: modelCacheStore,
    persistedModel,
    providerAuthFacts,
  });
  // Read the scoped catalog lane so a catalog-only publication rerenders this
  // picker; actual role-aware lookup remains inside modelCacheStore.
  void cliCatalogOutcomes;
  const modelCounts = countModelOptions(rightModels);
  const catalogDiagnostic =
    modelCounts.confirmed > 0 ? undefined : deriveCatalogDiagnostic(role, currentItem);

  const roleLabel = isPlanner ? 'Planner' : 'Implementer';
  const isCurrentTool = currentItem?.isCurrent ?? false;
  const currentModel = isCurrentTool ? persistedModel : undefined;
  const currentCommand = getRunnerCommand(runnerConfig);
  const currentCommandKind =
    runnerConfig.kind === 'shell' || runnerConfig.kind === 'agent' ? runnerConfig.kind : undefined;

  return {
    items,
    rightModels,
    currentItem,
    selectedItemId: ownedItemId,
    initialLeftIdx,
    focusModels,
    roleLabel,
    currentModel,
    persistedModel,
    discoveredModelCount: modelCounts.confirmed,
    modelCounts,
    catalogDiagnostic,
    currentCommand,
    currentCommandKind,
    customModels,
    setCurrentItem: (item) => {
      if (selectedItemId !== undefined) return;
      setUncontrolledItemId(item.id);
    },
  };
}
