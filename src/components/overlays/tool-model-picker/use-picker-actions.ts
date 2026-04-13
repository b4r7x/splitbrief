import { configStore } from '../../../stores/config.js';
import { overlayStore } from '../../../stores/overlay.js';
import { feedbackStore } from '../../../stores/feedback.js';
import { formatModelName } from '../../../core/model-display.js';
import type { Config } from '../../../types.js';
import type { PickerOption, ModelOption } from './picker-catalog.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import {
  commitPlannerSelection,
  commitImplementerSelection,
  commitCustomCommand,
  commitCustomModel,
  removeCustomModel,
} from './config-transforms.js';
import type { ViewState, ViewAction } from './view-state.js';

export interface PickerActions {
  confirm(selection: PickerOption, model: ModelOption | null): void;
  leftChange(item: PickerOption): void;
  deleteRight(item: ModelOption): void;
  customCommand(cmd: string): void;
  customModel(modelName: string): void;
  openCustomModel(item: PickerOption): void;
  closeOverlay(): void;
}

export function usePickerActions(
  role: 'planner' | 'implementer',
  onConfirm: ((updated: Config) => void) | undefined,
  catalog: PickerCatalog,
  viewState: ViewState,
  dispatchView: (action: ViewAction) => void,
): PickerActions {
  const isPlanner = role === 'planner';
  const config = configStore.useConfig();

  const commit = (updated: Config, message: string) => {
    if (onConfirm) {
      onConfirm(updated);
      return;
    }
    configStore.save(updated);
    feedbackStore.setMessage(message);
    overlayStore.close();
  };

  const commandBasedIndex = catalog.items.findIndex(item => item.kind === 'shell' || item.kind === 'agent');

  return {
    confirm(selection: PickerOption, model: ModelOption | null) {
      if (selection.kind === 'shell' || selection.kind === 'agent') {
        const selectionIndex = catalog.items.findIndex(item => item.id === selection.id);
        dispatchView({ type: 'open-custom-command', preservedLeftIndex: selectionIndex >= 0 ? selectionIndex : commandBasedIndex >= 0 ? commandBasedIndex : 0, intendedKind: selection.kind });
        return;
      }
      const label = model
        ? `${selection.displayName} › ${formatModelName(model.id)}`
        : selection.displayName;
      if (isPlanner) {
        commit(commitPlannerSelection(config, selection, model), `Planner set to: ${label}`);
      } else {
        commit(commitImplementerSelection(config, selection, model), `Implementer set to: ${label}`);
      }
    },
    leftChange(item: PickerOption) {
      catalog.setCurrentItem(item);
    },
    deleteRight(item: ModelOption) {
      const updated = removeCustomModel(config, role, item.id);
      configStore.save(updated);
      feedbackStore.setMessage(`Removed custom model: ${item.id}`);
    },
    customCommand(cmd: string) {
      if (viewState.view.kind !== 'custom-command') {
        throw new Error('customCommand called outside custom-command view');
      }
      commit(commitCustomCommand(config, role, cmd, viewState.view.intendedKind), `${catalog.roleLabel} set to: ${viewState.view.intendedKind}: ${cmd}`);
    },
    customModel(modelName: string) {
      if (viewState.view.kind !== 'custom-model') return;
      const customModelItem = viewState.view.item;
      const updated = commitCustomModel(config, role, customModelItem, modelName, catalog.customModels);
      commit(updated, `${catalog.roleLabel} set to: ${customModelItem.displayName} › ${formatModelName(modelName)}`);
    },
    openCustomModel(item: PickerOption) {
      dispatchView({ type: 'open-custom-model', item });
    },
    closeOverlay() {
      dispatchView({ type: 'close' });
    },
  };
}
