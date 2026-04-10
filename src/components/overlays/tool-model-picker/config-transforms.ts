import { getProviderBaseURL, isProviderId } from '../../../core/providers/catalog.js';
import { IMPLEMENTER_KINDS, type Config, type PlannerConfig, type PlannerTool } from '../../../types.js';
import { buildPlannerConfig } from '../../../core/config/planner-config.js';
import { includes } from '../../../utils/type-guards.js';

function toImplementerKind(id: string): Config['implementer']['kind'] {
  return includes(IMPLEMENTER_KINDS, id) ? id : 'api';
}

function toPlannerTool(id: string): PlannerTool {
  return isProviderId(id) ? id : 'claude-code';
}

function patchImplementer(config: Config, patch: Partial<Config['implementer']>): Config {
  return { ...config, implementer: { ...config.implementer, ...patch } };
}

function implementerApiPatch(config: Config, toolId: string): Partial<Config['implementer']> {
  const baseURL = getProviderBaseURL(toolId);
  const toolChanged = toolId !== config.implementer.tool;
  return {
    kind: 'api' as const,
    tool: toolId,
    ...(toolChanged && baseURL && { apiBase: baseURL }),
  };
}

function setPlanner(config: Config, planner: PlannerConfig): Config {
  return { ...config, planner };
}

import type { PickerOption } from './picker-catalog.js';

export function commitPlannerSelection(config: Config, selection: PickerOption, model: { id: string } | null): Config {
  const modelId = model ? model.id : undefined;
  return setPlanner(config, buildPlannerConfig(toPlannerTool(selection.id), { model: modelId, existing: config.planner }));
}

export function commitImplementerSelection(config: Config, selection: PickerOption, model: { id: string } | null): Config {
  if (selection.kind === 'cli') {
    return patchImplementer(config, {
      kind: toImplementerKind(selection.id),
      ...(model && { model: model.id }),
    });
  }

  return patchImplementer(config, {
    ...implementerApiPatch(config, selection.id),
    ...(model && { model: model.id }),
  });
}

export function commitCustomCommand(config: Config, role: 'planner' | 'implementer', command: string): Config {
  if (role === 'planner') {
    return setPlanner(config, { kind: 'shell', command });
  }
  return patchImplementer(config, { kind: 'shell', command });
}

export function commitCustomModel(
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
    return setPlanner(config, buildPlannerConfig(toPlannerTool(selection.id), { model: modelName, customModels: newCustomModels, existing: config.planner }));
  }

  if (selection.kind === 'cli') {
    return patchImplementer(config, {
      kind: toImplementerKind(selection.id),
      model: modelName,
      customModels: newCustomModels,
    });
  }

  return patchImplementer(config, {
    ...implementerApiPatch(config, selection.id),
    model: modelName,
    customModels: newCustomModels,
  });
}

export function removeCustomModel(config: Config, role: 'planner' | 'implementer', modelId: string): Config {
  if (role === 'planner') {
    const current = config.planner.customModels ?? [];
    const filtered = current.filter(m => m !== modelId);
    return setPlanner(config, { ...config.planner, customModels: filtered });
  }
  const current = config.implementer.customModels ?? [];
  return patchImplementer(config, { customModels: current.filter(m => m !== modelId) });
}
