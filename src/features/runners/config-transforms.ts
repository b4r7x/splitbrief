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
import { TOOL_EFFORT_LADDERS } from '../../core/providers/known-models.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import { EFFORT_LEVELS, type EffortLevel } from '../../core/schemas/enums.js';
import { includes } from '../../utils/type-guards.js';
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

/** A seat commit reports the effort level it had to drop, because nothing else can, and the axis value it kept — whichever field that landed in — so the save line names what was saved rather than what was asked for. */
export type SeatCommitResult = Readonly<{ config: Config; notice?: string; effort?: string }>;

function effortClearedNotice(effort: string, runner: PlannerConfig | ImplementerConfig): string {
  return `Effort ${effort} cleared: ${getRunnerCatalogDisplayName(runner)} has no effort channel`;
}

function variantClearedNotice(variant: string, runner: PlannerConfig | ImplementerConfig): string {
  return `Variant ${variant} cleared: ${getRunnerCatalogDisplayName(runner)} has no variant channel`;
}

function variantUnknownNotice(variant: string, model: string): string {
  return `Variant ${variant} cleared: ${model} has no such preset`;
}

function effortUnknownNotice(effort: string, model: string): string {
  return `Effort ${effort} cleared: ${model} has no such level`;
}

/**
 * The picker drafts one level and the seat's channel spells the field that spends it:
 * `effort-flag` writes `effort`, every other channel `variant` — where a seat without
 * that channel clears it and says so. One answer, so the ladder the row offered and the
 * field the commit writes cannot drift apart.
 */
function draftedLevel(
  next: PlannerConfig | ImplementerConfig,
  role: ActiveRunnerRole,
  level: string | null | undefined,
): Readonly<{ effort?: string | null; variant?: string | null }> {
  if (level === undefined) return {};
  return seatEffortChannel({ runner: next, role }) === 'effort-flag'
    ? { effort: level }
    : { variant: level };
}

/** A tool that publishes its levels as an example rather than an accept-list may be handed its own floor back: that list orders the offer and must not reject what the seat carries. A real per-model ladder from the same tool is authoritative and does reject. */
function ladderIsOpen(
  runner: PlannerConfig | ImplementerConfig,
  choices: readonly string[] | undefined,
): boolean {
  if (runner.kind !== 'cli' || choices === undefined) return false;
  const toolLadder = TOOL_EFFORT_LADDERS[runner.tool];
  if (toolLadder?.exhaustive !== false) return false;
  return (
    choices.length === toolLadder.levels.length &&
    choices.every((choice) => includes(toolLadder.levels, choice))
  );
}

function decideEffort<T extends PlannerConfig | ImplementerConfig>(
  input: Readonly<{
    next: T;
    requested: string | null | undefined;
    carried: EffortLevel | undefined;
    effortChoices: readonly string[] | undefined;
    role: ActiveRunnerRole;
    parse: (value: unknown) => T;
  }>,
): Readonly<{ runner: T; notice?: string }> {
  const { next, role, parse } = input;
  if (input.requested === null) {
    const { effort: _effort, ...rest } = next;
    return { runner: parse(rest) };
  }
  const effort = input.requested ?? next.effort ?? input.carried;
  if (effort === undefined) return { runner: next };
  if (seatEffortChannel({ runner: next, role }) === 'effort-flag') {
    // Only the model's own ladder can reject a level; an unanswered one keeps it. A rung
    // the schema cannot spell — a tool may publish one — is outside every ladder there is.
    if (
      !includes(EFFORT_LEVELS, effort) ||
      (!ladderIsOpen(next, input.effortChoices) &&
        input.effortChoices !== undefined &&
        !input.effortChoices.includes(effort))
    ) {
      const { effort: _effort, ...rest } = next;
      return {
        runner: parse(rest),
        notice: effortUnknownNotice(effort, next.model ?? 'this model'),
      };
    }
    return { runner: parse({ ...next, effort }) };
  }
  const { effort: _effort, ...rest } = next;
  return { runner: parse(rest), notice: effortClearedNotice(effort, next) };
}

function decideVariant<T extends PlannerConfig | ImplementerConfig>(
  input: Readonly<{
    next: T;
    requested: string | null | undefined;
    carried: string | undefined;
    carriedModel: string | undefined;
    effortChoices: readonly string[] | undefined;
    role: ActiveRunnerRole;
    parse: (value: unknown) => T;
  }>,
): Readonly<{ runner: T; notice?: string }> {
  const { next, requested, role, parse } = input;
  if (requested === null) {
    const { variant: _variant, ...rest } = next;
    return { runner: parse(rest) };
  }
  const variant = requested ?? next.variant ?? input.carried;
  if (variant === undefined) return { runner: next };
  if (seatEffortChannel({ runner: next, role }) !== 'variant') {
    const { variant: _variant, ...rest } = next;
    return { runner: parse(rest), notice: variantClearedNotice(variant, next) };
  }
  // A variant the picker never offered here rides in only by inheritance: a model
  // change re-checks it against the new model's vocabulary. An explicitly passed
  // name, and an unchanged model, keep whatever the seat already spelled.
  // No open ladder reaches here: the open ones are command-code's and codex's, and both spend
  // their effort on a flag, never on a variant.
  // The ladder is the caller's; an unknown or empty one answers nothing and keeps the variant.
  const knownChoices = input.effortChoices ?? [];
  if (
    requested === undefined &&
    next.model !== input.carriedModel &&
    knownChoices.length > 0 &&
    !knownChoices.includes(variant)
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
  /** The level the picker drafted: a token to save, null to clear, absent to leave alone. */
  effort?: string | null | undefined;
  /** The chosen model's own effort ladder. Absent means unknown — never a reason to clear. */
  effortChoices?: readonly string[] | undefined;
}

export function commitPlannerTierSelection(input: PlannerTierSelectionInput): SeatCommitResult {
  let notice: string | undefined;
  let kept: string | undefined;
  const parse = (value: unknown) => PlannerConfigSchema.parse(value);
  const config = updatePlannerTier(input.config, input.role, (existing) => {
    const next = buildRunnerConfig(input.role, {
      kind: input.selection.kind,
      tool: input.selection.id,
      ...(input.model !== null && { model: input.model.id }),
      existing,
    });
    const drafted = draftedLevel(next, input.role, input.effort);
    const effort = decideEffort({
      next,
      requested: drafted.effort,
      carried: existing.effort,
      effortChoices: input.effortChoices,
      role: input.role,
      parse,
    });
    const variant = decideVariant({
      next: effort.runner,
      requested: drafted.variant,
      carried: existing.variant,
      carriedModel: existing.model,
      effortChoices: input.effortChoices,
      role: input.role,
      parse,
    });
    notice = joinNotices(effort.notice, variant.notice);
    kept = variant.runner.variant ?? variant.runner.effort;
    return variant.runner;
  });
  return {
    config,
    ...(notice !== undefined && { notice }),
    ...(kept !== undefined && { effort: kept }),
  };
}

export interface ImplementerSelectionInput {
  config: Config;
  selection: RunnerPickerOption;
  model: { id: string } | null;
  /** The level the picker drafted: a token to save, null to clear, absent to leave alone. */
  effort?: string | null | undefined;
  /** The chosen model's own effort ladder. Absent means unknown — never a reason to clear. */
  effortChoices?: readonly string[] | undefined;
}

export function commitImplementerSelection(input: ImplementerSelectionInput): SeatCommitResult {
  let notice: string | undefined;
  let kept: string | undefined;
  const parse = (value: unknown) => ImplementerConfigSchema.parse(value);
  const updated = updateDefaultImplementerConfig(input.config, (existing) => {
    const next = buildRunnerConfig('implementer', {
      kind: input.selection.kind,
      tool: input.selection.id,
      ...(input.model !== null && { model: input.model.id }),
      existing,
    });
    const drafted = draftedLevel(next, 'implementer', input.effort);
    const effort = decideEffort({
      next,
      requested: drafted.effort,
      carried: existing.effort,
      effortChoices: input.effortChoices,
      role: 'implementer',
      parse,
    });
    const variant = decideVariant({
      next: effort.runner,
      requested: drafted.variant,
      carried: existing.variant,
      carriedModel: existing.model,
      effortChoices: input.effortChoices,
      role: 'implementer',
      parse,
    });
    notice = joinNotices(effort.notice, variant.notice);
    kept = variant.runner.variant ?? variant.runner.effort;
    return variant.runner;
  });
  return {
    config: updated,
    ...(notice !== undefined && { notice }),
    ...(kept !== undefined && { effort: kept }),
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
