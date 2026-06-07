import type { Config } from '../../core/schemas/config.js';
import { PlannerConfigSchema, type PlannerConfig } from '../../core/schemas/planner-config.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import { updateDefaultImplementerConfig } from '../../core/config/accessors/implementer-profiles.js';
import type { PickerOption } from './model-catalog.js';

function setPlanner(config: Config, planner: PlannerConfig): Config {
  return { ...config, planner };
}

export function commitPlannerSelection(
  config: Config,
  selection: PickerOption,
  model: { id: string } | null,
): Config {
  const opts = {
    kind: selection.kind,
    tool: selection.id,
    model: model?.id,
    existing: config.planner,
  };
  return setPlanner(config, buildRunnerConfig('planner', opts));
}

export function commitImplementerSelection(
  config: Config,
  selection: PickerOption,
  model: { id: string } | null,
): Config {
  return updateDefaultImplementerConfig(config, (existing) => {
    const opts = {
      kind: selection.kind,
      tool: selection.id,
      model: model?.id ?? existing.model,
      existing,
    };
    return buildRunnerConfig('implementer', opts);
  });
}

export interface CommitCustomCommandInput {
  config: Config;
  role: 'planner' | 'implementer';
  command: string;
  kind: 'shell' | 'agent';
}

export function commitCustomCommand(input: CommitCustomCommandInput): Config {
  const { config, role, command, kind } = input;
  if (role === 'planner') {
    return setPlanner(
      config,
      buildRunnerConfig('planner', { kind, command, existing: config.planner }),
    );
  }
  return updateDefaultImplementerConfig(config, (existing) =>
    buildRunnerConfig('implementer', { kind, command, existing, model: existing.model }),
  );
}

export interface CommitCustomModelInput {
  config: Config;
  role: 'planner' | 'implementer';
  selection: PickerOption;
  modelName: string;
  customModels: string[];
}

export function commitCustomModel(input: CommitCustomModelInput): Config {
  const { config, role, selection, modelName, customModels } = input;
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

  if (role === 'planner') return setPlanner(config, buildRunnerConfig('planner', opts));
  return updateDefaultImplementerConfig(config, (existing) =>
    buildRunnerConfig('implementer', { ...opts, existing }),
  );
}

export function removeCustomModel(
  config: Config,
  role: 'planner' | 'implementer',
  modelId: string,
): Config {
  if (role === 'planner') {
    const current = config.planner.customModels ?? [];
    const filtered = current.filter((m) => m !== modelId);
    if (config.planner.model !== modelId) {
      return setPlanner(config, { ...config.planner, customModels: filtered });
    }
    // exactOptionalPropertyTypes forbids { model: undefined } — destructure to omit.
    return setPlanner(config, omitModel(config.planner, filtered));
  }
  return updateDefaultImplementerConfig(config, (existing) => {
    const current = existing.customModels ?? [];
    const filtered = current.filter((m) => m !== modelId);
    if (existing.model !== modelId) {
      return { ...existing, customModels: filtered };
    }
    return {
      ...existing,
      model: filtered[0] ?? 'auto',
      customModels: filtered,
    };
  });
}

function omitModel(planner: PlannerConfig, customModels: string[]): PlannerConfig {
  const { model: _model, ...rest } = planner;
  return PlannerConfigSchema.parse({ ...rest, customModels });
}
