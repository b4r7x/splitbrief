import { useState } from 'react';
import { configStore } from '../../../stores/config.js';
import { overlayStore } from '../../../stores/overlay.js';
import { detectionStore } from '../../../stores/detection.js';
import {
  buildPlannerPickerOptions,
  buildImplementerPickerOptions,
  buildRightModels,
  type PickerOption,
  type ModelOption,
} from './picker-catalog.js';

export interface PickerCatalog {
  ready: boolean;
  items: PickerOption[];
  rightModels: ModelOption[];
  currentItem: PickerOption | undefined;
  initialLeftIdx: number;
  focusModels: boolean;
  roleLabel: string;
  currentModel: string | undefined;
  currentCommand: string | undefined;
  customModels: string[];
  selectedItem: PickerOption | null;
  setSelectedItem: (item: PickerOption | null) => void;
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
  const loading = detectionStore.use(s => s.loading);
  const ready = !!(isPlanner ? plannerDetections : implementerDetections) && !loading;

  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null);

  const items = isPlanner
    ? (plannerDetections ? buildPlannerPickerOptions(plannerDetections) : [])
    : (implementerDetections ? buildImplementerPickerOptions(implementerDetections) : []);

  const configId = isPlanner
    ? config.planner.tool
    : (selectedItem?.id ?? config.implementer.kind ?? config.implementer.tool);
  const configItemIndex = items.findIndex(item => item.id === configId);
  const initialLeftIdx = focusModels && configItemIndex >= 0 ? configItemIndex : preservedLeftIndex;

  const customModels = isPlanner
    ? (config.planner.customModels ?? [])
    : (config.implementer.customModels ?? []);

  const currentItem = items.find(item => item.id === configId) ?? items[0];

  const rightModels = buildRightModels({
    isPlanner,
    customModels,
    plannerTool: config.planner.tool,
    implementerDetections,
    currentItem,
  });

  const roleLabel = isPlanner ? 'Planner' : 'Implementer';
  const currentModel = isPlanner ? config.planner.model : config.implementer.model;
  const currentCommand = isPlanner ? config.planner.command : config.implementer.command;

  return {
    ready,
    items,
    rightModels,
    currentItem,
    initialLeftIdx,
    focusModels,
    roleLabel,
    currentModel,
    currentCommand,
    customModels,
    selectedItem,
    setSelectedItem,
  };
}
