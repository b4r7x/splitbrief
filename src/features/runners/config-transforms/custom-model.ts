import { updateActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { buildRunnerConfig } from '../../../core/config/runtime/build-runner.js';
import { type SeatPickerRole, seatPickerLane } from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import { type PlannerConfig, PlannerConfigSchema } from '../../../core/schemas/runner/planner.js';
import type { RunnerPickerOption } from '../model-catalog/options.js';
import { updatePlannerTier } from './seat-selection.js';

export interface CommitCustomCommandInput {
  config: Config;
  role: SeatPickerRole;
  command: string;
  kind: 'shell' | 'agent';
  profile?: string | undefined;
}

export function commitCustomCommand(input: CommitCustomCommandInput): Config {
  const { config, command, kind } = input;
  const lane = seatPickerLane(input.role);
  if (lane === 'implementer') {
    return updateActiveRunner({
      config,
      role: 'implementer',
      profile: input.profile,
      updater: (existing) =>
        buildRunnerConfig('implementer', { kind, command, existing, model: existing.model }),
    });
  }
  return updatePlannerTier(config, lane, (existing) =>
    buildRunnerConfig(lane, { kind, command, existing }),
  );
}

export interface CommitCustomModelInput {
  config: Config;
  role: SeatPickerRole;
  selection: RunnerPickerOption;
  modelName: string;
  customModels: string[];
  profile?: string | undefined;
}

export function commitCustomModel(input: CommitCustomModelInput): Config {
  const { config, selection, modelName, customModels } = input;
  const lane = seatPickerLane(input.role);
  const newCustomModels = customModels.includes(modelName)
    ? customModels
    : [...customModels, modelName];

  const opts = {
    kind: selection.kind,
    tool: selection.id,
    model: modelName,
    customModels: newCustomModels,
  };

  if (lane === 'implementer') {
    return updateActiveRunner({
      config,
      role: 'implementer',
      profile: input.profile,
      updater: (existing) => buildRunnerConfig('implementer', { ...opts, existing }),
    });
  }
  return updatePlannerTier(config, lane, (existing) =>
    buildRunnerConfig(lane, { ...opts, existing }),
  );
}

export function removeCustomModel(
  config: Config,
  role: SeatPickerRole,
  modelId: string,
  profile?: string | undefined,
): Config {
  const lane = seatPickerLane(role);
  if (lane !== 'implementer') {
    return updatePlannerTier(config, lane, (existing) => {
      const filtered = (existing.customModels ?? []).filter((m) => m !== modelId);
      if (existing.model !== modelId) return { ...existing, customModels: filtered };
      // exactOptionalPropertyTypes forbids { model: undefined } — destructure to omit.
      return omitModel(existing, filtered);
    });
  }
  return updateActiveRunner({
    config,
    role: 'implementer',
    profile,
    updater: (existing) => {
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
    },
  });
}

function omitModel(planner: PlannerConfig, customModels: string[]): PlannerConfig {
  const { model: _model, ...rest } = planner;
  return PlannerConfigSchema.parse({ ...rest, customModels });
}
