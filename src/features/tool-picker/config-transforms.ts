import type { Config, ImplementerConfig, PlannerConfig } from '../../core/types/config-options.js';
import { buildRunnerConfig } from '../../core/config/build-runner.js';
import type { PickerOption } from './picker-model-catalog.js';

function setPlanner(config: Config, planner: PlannerConfig): Config {
  return { ...config, planner };
}

function setImplementer(config: Config, implementer: ImplementerConfig): Config {
  return { ...config, implementer };
}

function commitForRole(config: Config, role: 'planner' | 'implementer', opts: Parameters<typeof buildRunnerConfig>[1]): Config {
  if (role === 'planner') return setPlanner(config, buildRunnerConfig('planner', opts));
  return setImplementer(config, buildRunnerConfig('implementer', opts));
}

export function commitPlannerSelection(config: Config, selection: PickerOption, model: { id: string } | null): Config {
  const opts = {
    kind: selection.kind,
    tool: selection.id,
    model: model?.id,
    existing: config.planner,
  };
  return setPlanner(config, buildRunnerConfig('planner', opts));
}

export function commitImplementerSelection(config: Config, selection: PickerOption, model: { id: string } | null): Config {
  const opts = {
    kind: selection.kind,
    tool: selection.id,
    model: model?.id ?? config.implementer.model,
    existing: config.implementer,
  };
  return setImplementer(config, buildRunnerConfig('implementer', opts));
}

export function commitCustomCommand(config: Config, role: 'planner' | 'implementer', command: string, kind: 'shell' | 'agent'): Config {
  const opts = {
    kind,
    command,
    existing: role === 'planner' ? config.planner : config.implementer,
    ...(role === 'implementer' && { model: config.implementer.model }),
  };

  return commitForRole(config, role, opts);
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

  const opts = {
    kind: selection.kind,
    tool: selection.id,
    model: modelName,
    customModels: newCustomModels,
    existing: role === 'planner' ? config.planner : config.implementer,
  };
  
  return commitForRole(config, role, opts);
}

export function removeCustomModel(config: Config, role: 'planner' | 'implementer', modelId: string): Config {
  if (role === 'planner') {
    const current = config.planner.customModels ?? [];
    const filtered = current.filter(m => m !== modelId);
    if (config.planner.model !== modelId) {
      return setPlanner(config, { ...config.planner, customModels: filtered });
    }
    // exactOptionalPropertyTypes forbids { model: undefined } — destructure to omit.
    return setPlanner(config, omitModel(config.planner, filtered));
  }
  const current = config.implementer.customModels ?? [];
  const filtered = current.filter(m => m !== modelId);
  if (config.implementer.model !== modelId) {
    return setImplementer(config, { ...config.implementer, customModels: filtered });
  }
  const fallbackModel = filtered[0] ?? config.implementer.model;
  return setImplementer(config, { ...config.implementer, model: fallbackModel, customModels: filtered });
}

function omitModel(planner: PlannerConfig, customModels: string[]): PlannerConfig {
  switch (planner.kind) {
    case 'cli': {
      const { model: _m, ...rest } = planner;
      return { ...rest, customModels };
    }
    case 'api': {
      const { model: _m, ...rest } = planner;
      return { ...rest, customModels };
    }
    case 'shell': {
      const { model: _m, ...rest } = planner;
      return { ...rest, customModels };
    }
    case 'agent': {
      const { model: _m, ...rest } = planner;
      return { ...rest, customModels };
    }
    case 'agent-sdk': {
      const { model: _m, ...rest } = planner;
      return { ...rest, customModels };
    }
  }
}
