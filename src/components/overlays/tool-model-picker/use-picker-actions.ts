import { configStore } from '../../../stores/config.js';
import { overlayStore } from '../../../stores/overlay.js';
import { feedbackStore } from '../../../stores/feedback.js';
import { formatModelName } from '../../../core/providers/models.js';
import { getProvider } from '../../../engine/providers/registry.js';
import type { Config, PlannerTool } from '../../../types.js';
import type { PickerOption, ModelOption } from './picker-catalog.js';
import type { ViewAction, ViewState } from './tool-model-picker.js';
import type { PickerCatalog } from './use-picker-catalog.js';

function patchRole(config: Config, role: 'planner' | 'implementer', patch: Record<string, unknown>): Config {
  return { ...config, [role]: { ...config[role], ...patch } } as Config;
}

function commitPlannerSelection(config: Config, selection: PickerOption, model: ModelOption | null): Config {
  return patchRole(config, 'planner', {
    tool: selection.id as PlannerTool,
    model: model ? model.id : undefined,
  });
}

function commitImplementerSelection(config: Config, selection: PickerOption, model: ModelOption | null): Config {
  if (selection.kind === 'cli') {
    return patchRole(config, 'implementer', {
      kind: selection.id as Config['implementer']['kind'],
      ...(model && { model: model.id }),
    });
  }

  const toolChanged = selection.id !== config.implementer.tool;
  const providerDef = getProvider(selection.id);
  return patchRole(config, 'implementer', {
    kind: 'api' as const,
    tool: selection.id,
    ...(model && { model: model.id }),
    ...(toolChanged && { apiBase: providerDef.baseURL }),
  });
}

function commitCustomCommand(config: Config, role: 'planner' | 'implementer', command: string): Config {
  const toolKey = role === 'planner' ? 'tool' : 'kind';
  return patchRole(config, role, { [toolKey]: 'shell', command });
}

function commitCustomModel(
  config: Config,
  role: 'planner' | 'implementer',
  selection: PickerOption,
  modelName: string,
  customModels: string[],
): Config {
  const newCustomModels = customModels.includes(modelName)
    ? customModels
    : [...customModels, modelName];

  if (role === 'planner') {
    return patchRole(config, 'planner', {
      tool: selection.id as PlannerTool,
      model: modelName,
      customModels: newCustomModels,
    });
  }

  const isTool = selection.kind === 'cli';
  const providerDef = isTool ? null : getProvider(selection.id);
  return patchRole(config, 'implementer', {
    ...(isTool
      ? { kind: selection.id as Config['implementer']['kind'] }
      : {
          kind: 'api' as const,
          tool: selection.id,
          ...(selection.id !== config.implementer.tool && providerDef && { apiBase: providerDef.baseURL }),
        }),
    model: modelName,
    customModels: newCustomModels,
  });
}

function removeCustomModel(config: Config, role: 'planner' | 'implementer', modelId: string): Config {
  const current = role === 'planner'
    ? (config.planner.customModels ?? [])
    : (config.implementer.customModels ?? []);
  return patchRole(config, role, { customModels: current.filter(m => m !== modelId) });
}

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

  const shellIndex = catalog.items.findIndex(item => item.kind === 'shell');

  return {
    confirm(selection: PickerOption, model: ModelOption | null) {
      if (selection.kind === 'shell') {
        dispatchView({ type: 'open-custom-command', preservedLeftIndex: shellIndex >= 0 ? shellIndex : 0 });
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
      commit(commitCustomCommand(config, role, cmd), `${catalog.roleLabel} set to: shell: ${cmd}`);
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
