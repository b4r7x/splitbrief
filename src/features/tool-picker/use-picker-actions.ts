import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { error } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import { formatModelName } from '../../core/model-display.js';
import type { Config } from '../../core/schemas/config.js';
import type { PickerOption, ModelOption } from './model-catalog.js';
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

function collectChangedPaths(before: unknown, after: unknown, prefix: string): string[] {
  if (Object.is(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return Array.from(keys).flatMap(key => collectChangedPaths(before[key], after[key], `${prefix}.${key}`));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [prefix];
}

function runnerChangedPaths(config: Config, updated: Config, role: 'planner' | 'implementer', extra: string[] = []): string[] {
  const changed = collectChangedPaths(config[role], updated[role], role);
  return Array.from(new Set([...changed, ...extra]));
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

  const commit = (updated: Config, message: string, changedPaths?: string[] | undefined) => {
    if (onConfirm) {
      onConfirm(updated);
      return;
    }
    const result = configStore.save(updated, changedPaths ? { changedPaths } : undefined);
    if (result.ok) {
      feedbackStore.setMessage(message);
      overlayStore.close();
    } else if (result.error) {
      feedbackStore.setError(`Failed to save config: ${result.error.message}`);
    }
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
        const updated = commitPlannerSelection(config, selection, model);
        commit(updated, `Planner set to: ${label}`, runnerChangedPaths(config, updated, 'planner', [
          'planner.kind',
          'planner.tool',
          'planner.provider',
          ...(model ? ['planner.model'] : []),
        ]));
      } else {
        const updated = commitImplementerSelection(config, selection, model);
        commit(updated, `Implementer set to: ${label}`, runnerChangedPaths(config, updated, 'implementer', [
          'implementer.kind',
          'implementer.tool',
          'implementer.provider',
          'implementer.model',
        ]));
      }
    },
    leftChange(item: PickerOption) {
      catalog.setCurrentItem(item);
    },
    deleteRight(item: ModelOption) {
      const updated = removeCustomModel(config, role, item.id);
      const result = configStore.save(updated, {
        changedPaths: runnerChangedPaths(config, updated, role, [`${role}.customModels`, `${role}.model`]),
      });
      if (result.ok) {
        feedbackStore.setMessage(`Removed custom model: ${item.id}`);
      } else if (result.error) {
        feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      }
    },
    customCommand(cmd: string) {
      if (viewState.view.kind !== 'custom-command') {
        throw error(
          'picker-invalid-view',
          'customCommand called outside custom-command view',
          { view: viewState.view.kind },
        );
      }
      const updated = commitCustomCommand(config, role, cmd, viewState.view.intendedKind);
      commit(updated, `${catalog.roleLabel} set to: ${viewState.view.intendedKind}: ${cmd}`, runnerChangedPaths(config, updated, role, [
        `${role}.kind`,
        `${role}.tool`,
        `${role}.command`,
        ...(role === 'implementer' ? [`${role}.model`] : []),
      ]));
    },
    customModel(modelName: string) {
      if (viewState.view.kind !== 'custom-model') return;
      const customModelItem = viewState.view.item;
      const updated = commitCustomModel(config, role, customModelItem, modelName, catalog.customModels);
      commit(updated, `${catalog.roleLabel} set to: ${customModelItem.displayName} › ${formatModelName(modelName)}`, runnerChangedPaths(config, updated, role, [
        `${role}.kind`,
        `${role}.tool`,
        `${role}.provider`,
        `${role}.model`,
        `${role}.customModels`,
      ]));
    },
    openCustomModel(item: PickerOption) {
      dispatchView({ type: 'open-custom-model', item });
    },
    closeOverlay() {
      dispatchView({ type: 'close' });
    },
  };
}
