import { useState } from 'react';
import { configStore } from '../../../stores/config.js';
import { overlayStore } from '../../../stores/overlay.js';
import { detectionStore } from '../../../stores/detection.js';
import { getPlannerCommand } from '../../../core/config/planner-config.js';
import {
  buildPlannerPickerOptions,
  buildImplementerPickerOptions,
  buildRightModels,
  isCurrentConfig,
  type PickerOption,
  type ModelOption,
} from './picker-catalog.js';

export interface PickerCatalog {
  items: PickerOption[];
  rightModels: ModelOption[];
  currentItem: PickerOption | undefined;
  initialLeftIdx: number;
  focusModels: boolean;
  roleLabel: string;
  currentModel: string | undefined;
  currentCommand: string | undefined;
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

  const plannerDetections = detectionStore.use(s => s.planners);
  const implementerDetections = detectionStore.use(s => s.implementers);

  const [currentItemId, setCurrentItemId] = useState<string | null>(null);

  const rawItems = isPlanner
    ? buildPlannerPickerOptions(plannerDetections)
    : buildImplementerPickerOptions(implementerDetections);
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

  const initialItem = items[initialLeftIdx] ?? items[0];
  const currentItem = items.find(item => item.id === currentItemId) ?? initialItem;

  const rightModels = buildRightModels({
    isPlanner,
    customModels,
    implementerDetections,
    currentItem,
  });

  const roleLabel = isPlanner ? 'Planner' : 'Implementer';
  const currentModel = isPlanner ? config.planner.model : config.implementer.model;
  const currentCommand = isPlanner ? getPlannerCommand(config.planner) : config.implementer.command;

  return {
    items,
    rightModels,
    currentItem,
    initialLeftIdx,
    focusModels,
    roleLabel,
    currentModel,
    currentCommand,
    customModels,
    setCurrentItem: (item) => setCurrentItemId(item.id),
  };
}
