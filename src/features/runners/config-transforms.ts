import type { Config } from '../../core/schemas/config.js';
import { PlannerConfigSchema, type PlannerConfig } from '../../core/schemas/planner-config.js';
import {
  ImplementerConfigSchema,
  type ImplementerConfig,
} from '../../core/schemas/implementer-config.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import { updateDefaultImplementerConfig } from '../../core/config/accessors/implementer-profiles.js';
import type { PickerOption } from './model-catalog.js';

function setPlanner(config: Config, planner: PlannerConfig): Config {
  return { ...config, planner };
}

function isAutomaticCliSelection(selection: PickerOption, model: { id: string } | null): boolean {
  return selection.kind === 'cli' && model?.id.trim().toLowerCase() === 'auto';
}

function plannerWithoutModel(config: PlannerConfig): PlannerConfig {
  const { model: _model, ...rest } = config;
  return PlannerConfigSchema.parse(rest);
}

function implementerWithoutModel(config: ImplementerConfig): ImplementerConfig {
  // API implementers require a model.  Automatic selection is a CLI-only
  // sentinel, so never destructure a model from an API profile even if this
  // helper is reused by a future selection path.
  if (config.kind !== 'cli') return config;
  const { model: _model, ...rest } = config;
  return ImplementerConfigSchema.parse(rest);
}

function plannerExistingForSelection(
  config: PlannerConfig,
  selection: PickerOption,
  automaticSelection: boolean,
): PlannerConfig {
  return automaticSelection && config.kind === 'cli' && config.tool === selection.id
    ? plannerWithoutModel(config)
    : config;
}

function implementerExistingForSelection(
  config: ImplementerConfig,
  selection: PickerOption,
  automaticSelection: boolean,
): ImplementerConfig {
  const sameCliTarget =
    selection.kind === 'cli' && config.kind === 'cli' && config.tool === selection.id;
  return automaticSelection && sameCliTarget ? implementerWithoutModel(config) : config;
}

export function commitPlannerSelection(
  config: Config,
  selection: PickerOption,
  model: { id: string } | null,
): Config {
  const automaticSelection = isAutomaticCliSelection(selection, model);
  const opts = {
    kind: selection.kind,
    tool: selection.id,
    ...(model !== null && !automaticSelection && { model: model.id }),
    existing: plannerExistingForSelection(config.planner, selection, automaticSelection),
  };
  return setPlanner(config, buildRunnerConfig('planner', opts));
}

export function commitImplementerSelection(
  config: Config,
  selection: PickerOption,
  model: { id: string } | null,
): Config {
  return updateDefaultImplementerConfig(config, (existing) => {
    const automaticSelection = isAutomaticCliSelection(selection, model);
    const opts = {
      kind: selection.kind,
      tool: selection.id,
      ...(model !== null && !automaticSelection && { model: model.id }),
      existing: implementerExistingForSelection(existing, selection, automaticSelection),
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
    const fallbackModel = filtered[0];
    if (fallbackModel !== undefined) {
      return { ...existing, model: fallbackModel, customModels: filtered };
    }
    if (existing.kind !== 'cli') {
      return { ...existing, customModels: filtered };
    }
    const { model: _model, ...rest } = existing;
    return { ...rest, customModels: filtered };
  });
}

function omitModel(planner: PlannerConfig, customModels: string[]): PlannerConfig {
  const { model: _model, ...rest } = planner;
  return PlannerConfigSchema.parse({ ...rest, customModels });
}
