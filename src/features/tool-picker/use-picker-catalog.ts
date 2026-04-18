import { useState } from 'react';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { detectionStore } from '../../stores/project/detection.js';
import { useStores } from '../../stores/use-stores.js';
import { getRunnerCommand } from '../../core/config/accessors/runner-config.js';
import { normalizeConfiguredModel } from '../../core/providers/model-selection.js';
import {
  buildPlannerPickerOptions,
  buildImplementerPickerOptions,
  buildRightModelsForPicker,
  isCurrentConfig,
  type PickerOption,
  type ModelOption,
} from './model-catalog.js';

export interface PickerCatalog {
  items: PickerOption[];
  rightModels: ModelOption[];
  currentItem: PickerOption | undefined;
  initialLeftIdx: number;
  focusModels: boolean;
  roleLabel: string;
  currentModel: string | undefined;
  currentCommand: string | undefined;
  currentCommandKind: 'shell' | 'agent' | undefined;
  customModels: string[];
  setCurrentItem: (item: PickerOption) => void;
}

export function usePickerCatalog(
  role: 'planner' | 'implementer',
  preservedLeftIndex: number,
): PickerCatalog {
  const isPlanner = role === 'planner';
  const config = configStore.useConfig();
  const focusModels = overlayStore.use(s => s.focus) === 'models';

  const [{ planners: plannerDetections, implementers: implementerDetections }] = useStores(detectionStore);

  const [currentItemId, setCurrentItemId] = useState<string | null>(null);

  const rawItems = isPlanner
    ? buildPlannerPickerOptions({ detections: plannerDetections, implementerDetections })
    : buildImplementerPickerOptions({ detections: implementerDetections, plannerDetections });
  const items: PickerOption[] = rawItems.map(item => ({
    ...item,
    isCurrent: isCurrentConfig(item, config, role),
  }));

  const configItemIndex = items.findIndex(item => item.isCurrent);
  const preservedIndex = Math.min(preservedLeftIndex, Math.max(0, items.length - 1));
  const initialLeftIdx = configItemIndex >= 0 ? configItemIndex : preservedIndex;

  const customModels = isPlanner
    ? (config.planner.customModels ?? [])
    : (config.implementer.customModels ?? []);
  const runnerConfig = isPlanner ? config.planner : config.implementer;

  const initialItem = items[initialLeftIdx] ?? items[0];
  const currentItem = items.find(item => item.id === currentItemId) ?? initialItem;

  const rightModels = buildRightModelsForPicker({
    isPlanner,
    customModels,
    currentItem,
  });

  const roleLabel = isPlanner ? 'Planner' : 'Implementer';
  const isCurrentTool = currentItem?.isCurrent ?? false;
  const currentModel = isCurrentTool
    ? normalizeConfiguredModel(
        runnerConfig.model,
        currentItem?.id,
      )
    : undefined;
  const currentCommand = getRunnerCommand(runnerConfig);
  const currentCommandKind = runnerConfig.kind === 'shell' || runnerConfig.kind === 'agent'
    ? runnerConfig.kind
    : undefined;

  return {
    items,
    rightModels,
    currentItem,
    initialLeftIdx,
    focusModels,
    roleLabel,
    currentModel,
    currentCommand,
    currentCommandKind,
    customModels,
    setCurrentItem: (item) => setCurrentItemId(item.id),
  };
}
