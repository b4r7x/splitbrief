import { modelCacheStore } from '../../../stores/model-cache.js';
import { buildRightModels } from './picker-model-catalog.js';
export type { ModelOption, PickerOption } from './picker-model-catalog.js';
import type { ModelOption, PickerOption } from './picker-model-catalog.js';

export function buildRightModelsForPicker(params: {
  isPlanner: boolean;
  customModels: string[];
  currentItem: PickerOption | undefined;
}): ModelOption[] {
  return buildRightModels({ ...params, cache: modelCacheStore });
}
