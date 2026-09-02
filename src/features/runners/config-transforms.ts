import type { Config } from '../../core/schemas/config.js';
import { PlannerConfigSchema, type PlannerConfig } from '../../core/schemas/planner-config.js';
import {
  ImplementerConfigSchema,
  type ImplementerConfig,
} from '../../core/schemas/implementer-config.js';
import { SOFT_SEP } from '../../components/separators.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import { updateActiveRunner } from '../../core/config/accessors/active-runner.js';
import {
  seatPickerLane,
  type ActiveRunnerRole,
  type PlannerTierRole,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import { seatEffortChannel } from '../../core/runners/capabilities.js';
import { variantChoicesForModelId } from '../../core/runners/variant-vocabulary.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import { updateDefaultImplementerConfig } from '../../core/config/accessors/implementer-profiles.js';
import type { RunnerPickerOption } from './model-catalog/options.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';

/** The planner-tier seats share the planner's runner shape; only the config node differs. */
function updatePlannerTier(
  config: Config,
  role: PlannerTierRole,
  updater: (existing: PlannerConfig) => PlannerConfig,
): Config {
  return updateActiveRunner({ config, role, updater });
}

export function inheritsPlannerSeat(config: Config, role: SeatPickerRole): boolean {
  return seatPickerLane(role) === 'reviewer' && resolveReviewerRunner(config).source === 'planner';
}

/**
 * A seat commit reports the effort level it had to drop, because nothing else
 * can, and the variant it kept, so the save line names what was saved rather
 * than what was asked for.
 */
export type SeatCommitResult = Readonly<{ config: Config; notice?: string; variant?: string }>;

function effortClearedNotice(
  effort: EffortLevel,
  runner: PlannerConfig | ImplementerConfig,
): string {
  return `Effort ${effort} cleared: ${getRunnerCatalogDisplayName(runner)} has no effort channel`;
}

function variantClearedNotice(variant: string, runner: PlannerConfig | ImplementerConfig): string {
  return `Variant ${variant} cleared: ${getRunnerCatalogDisplayName(runner)} has no variant channel`;
}

function variantUnknownNotice(variant: string, model: string): string {
  return `Variant ${variant} cleared: ${model} has no such preset`;
}

function decideEffort<T extends PlannerConfig | ImplementerConfig>(
  input: Readonly<{
    next: T;
    carried: EffortLevel | undefined;
    role: ActiveRunnerRole;
    parse: (value: unknown) => T;
  }>,
): Readonly<{ runner: T; notice?: string }> {
  const { next, role, parse } = input;
  const effort = next.effort ?? input.carried;
  if (effort === undefined) return { runner: next };
  if (seatEffortChannel({ runner: next, role }) === 'effort-flag') {
    return { runner: parse({ ...next, effort }) };
  }
  const { effort: _effort, ...rest } = next;
  return { runner: parse(rest), notice: effortClearedNotice(effort, next) };
}

function decideVariant<T extends PlannerConfig | ImplementerConfig>(
  input: Readonly<{
    next: T;
    requested: string | undefined;
    carried: string | undefined;
    carriedModel: string | undefined;
    role: ActiveRunnerRole;
    parse: (value: unknown) => T;
  }>,
): Readonly<{ runner: T; notice?: string }> {
  const { next, requested, role, parse } = input;
  const variant = next.variant ?? requested ?? input.carried;
  if (variant === undefined) return { runner: next };
  if (seatEffortChannel({ runner: next, role }) !== 'variant') {
    const { variant: _variant, ...rest } = next;
    return { runner: parse(rest), notice: variantClearedNotice(variant, next) };
  }
  // A variant the picker never offered here rides in only by inheritance: a model
  // change re-checks it against the new model's vocabulary. An explicitly passed
  // name, and an unchanged model, keep whatever the seat already spelled.
  if (
    requested === undefined &&
    next.model !== input.carriedModel &&
    !variantChoicesForModelId(next.model).includes(variant)
  ) {
    const { variant: _variant, ...rest } = next;
    return {
      runner: parse(rest),
      notice: variantUnknownNotice(variant, next.model ?? 'this model'),
    };
  }
  return { runner: parse({ ...next, variant }) };
}

/** Two drops in one commit are two pieces of news; a single line carries both. */
function joinNotices(...notices: readonly (string | undefined)[]): string | undefined {
  const lines = notices.filter((line) => line !== undefined);
  return lines.length === 0 ? undefined : lines.join(SOFT_SEP);
}

export interface PlannerTierSelectionInput {
  config: Config;
  role: PlannerTierRole;
  selection: RunnerPickerOption;
  model: { id: string } | null;
  variant?: string | undefined;
}

export function commitPlannerTierSelection(input: PlannerTierSelectionInput): SeatCommitResult {
  let notice: string | undefined;
  let kept: string | undefined;
  const parse = (value: unknown) => PlannerConfigSchema.parse(value);
  const config = updatePlannerTier(input.config, input.role, (existing) => {
    const effort = decideEffort({
      next: buildRunnerConfig(input.role, {
        kind: input.selection.kind,
        tool: input.selection.id,
        ...(input.model !== null && { model: input.model.id }),
        ...(input.variant !== undefined && { variant: input.variant }),
        existing,
      }),
      carried: existing.effort,
      role: input.role,
      parse,
    });
    const variant = decideVariant({
      next: effort.runner,
      requested: input.variant,
      carried: existing.variant,
      carriedModel: existing.model,
      role: input.role,
      parse,
    });
    notice = joinNotices(effort.notice, variant.notice);
    kept = variant.runner.variant;
    return variant.runner;
  });
  return {
    config,
    ...(notice !== undefined && { notice }),
    ...(kept !== undefined && { variant: kept }),
  };
}

export interface ImplementerSelectionInput {
  config: Config;
  selection: RunnerPickerOption;
  model: { id: string } | null;
  variant?: string | undefined;
}

export function commitImplementerSelection(input: ImplementerSelectionInput): SeatCommitResult {
  let notice: string | undefined;
  let kept: string | undefined;
  const parse = (value: unknown) => ImplementerConfigSchema.parse(value);
  const next = updateDefaultImplementerConfig(input.config, (existing) => {
    const effort = decideEffort({
      next: buildRunnerConfig('implementer', {
        kind: input.selection.kind,
        tool: input.selection.id,
        ...(input.model !== null && { model: input.model.id }),
        ...(input.variant !== undefined && { variant: input.variant }),
        existing,
      }),
      carried: existing.effort,
      role: 'implementer',
      parse,
    });
    const variant = decideVariant({
      next: effort.runner,
      requested: input.variant,
      carried: existing.variant,
      carriedModel: existing.model,
      role: 'implementer',
      parse,
    });
    notice = joinNotices(effort.notice, variant.notice);
    kept = variant.runner.variant;
    return variant.runner;
  });
  return {
    config: next,
    ...(notice !== undefined && { notice }),
    ...(kept !== undefined && { variant: kept }),
  };
}

export interface CommitCustomCommandInput {
  config: Config;
  role: SeatPickerRole;
  command: string;
  kind: 'shell' | 'agent';
}

export function commitCustomCommand(input: CommitCustomCommandInput): Config {
  const { config, command, kind } = input;
  const lane = seatPickerLane(input.role);
  if (lane === 'implementer') {
    return updateDefaultImplementerConfig(config, (existing) =>
      buildRunnerConfig('implementer', { kind, command, existing, model: existing.model }),
    );
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
    return updateDefaultImplementerConfig(config, (existing) =>
      buildRunnerConfig('implementer', { ...opts, existing }),
    );
  }
  return updatePlannerTier(config, lane, (existing) =>
    buildRunnerConfig(lane, { ...opts, existing }),
  );
}

export function removeCustomModel(config: Config, role: SeatPickerRole, modelId: string): Config {
  const lane = seatPickerLane(role);
  if (lane !== 'implementer') {
    return updatePlannerTier(config, lane, (existing) => {
      const filtered = (existing.customModels ?? []).filter((m) => m !== modelId);
      if (existing.model !== modelId) return { ...existing, customModels: filtered };
      // exactOptionalPropertyTypes forbids { model: undefined } — destructure to omit.
      return omitModel(existing, filtered);
    });
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
