import { useState } from 'react';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { detectionStore } from '../../stores/project/detection.js';
import { useStores } from '../../stores/use-stores.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { getRunnerCommand } from '../../core/config/accessors/runner-config.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel } from '../../core/providers/automatic-model.js';
import { buildRightModels, isCurrentConfig } from './model-catalog/catalog.js';
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
  discoveredModelCount: number;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
  customModels: string[];
  setCurrentItem: (item: PickerOption) => void;
}

export function usePickerCatalog(
  role: 'planner' | 'implementer',
  preservedLeftIndex: number,
  selectedItemId?: string | null,
): PickerCatalog {
  const isPlanner = role === 'planner';
  const config = configStore.useConfig();
  const focusModels = overlayStore.use((s) => s.focus) === 'models';

  const [{ cliTools, implementers }] = useStores(detectionStore);

  const [uncontrolledItemId, setUncontrolledItemId] = useState<string | null>(null);

  const rawItems = buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    { cliTools, providers: implementers },
    undefined,
  );
  const items: PickerOption[] = rawItems.map((item) => ({
    ...item,
    isCurrent: isCurrentConfig(item, config, role),
  }));

  const configItemIndex = items.findIndex((item) => item.isCurrent);
  const configuredItem = configItemIndex >= 0 ? items[configItemIndex] : undefined;
  const preservedIndex = Math.min(preservedLeftIndex, Math.max(0, items.length - 1));
  const initialLeftIdx = configItemIndex >= 0 ? configItemIndex : preservedIndex;

  const runnerConfig = isPlanner
    ? config.planner
    : resolveImplementerProfiles(config).defaultProfile.config;
  const customModels = runnerConfig.customModels ?? [];

  const defaultItemId = items[initialLeftIdx]?.id ?? items[0]?.id;
  const ownedItemId =
    selectedItemId !== undefined && selectedItemId !== null
      ? selectedItemId
      : (uncontrolledItemId ?? defaultItemId);
  const currentItem = items.find((item) => item.id === ownedItemId) ?? items[0];

  const rightModels = buildRightModels({
    isPlanner,
    customModels,
    currentItem,
    cache: modelCacheStore,
  });

  const roleLabel = isPlanner ? 'Planner' : 'Implementer';
  const isCurrentTool = currentItem?.isCurrent ?? false;
  // Both spellings of automatic selection — `auto` and model absence — collapse
  // onto the single synthesized Auto row, so there is one highlighted identity.
  const configuredModel = normalizeConfiguredModel(runnerConfig.model);
  const persistedModel =
    configuredModel ??
    (configuredItem?.modelCapability.allowsAutomatic ? AUTOMATIC_MODEL : undefined);
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
    discoveredModelCount: rightModels.filter((model) => model.id !== AUTOMATIC_MODEL).length,
    currentCommand,
    currentCommandKind,
    customModels,
    setCurrentItem: (item) => {
      if (selectedItemId !== undefined) return;
      setUncontrolledItemId(item.id);
    },
  };
}
