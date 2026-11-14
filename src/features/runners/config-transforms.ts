import type { Config } from '../../core/schemas/config.js';
import { PlannerConfigSchema, type PlannerConfig } from '../../core/schemas/runner/planner.js';
import {
  ImplementerConfigSchema,
  type ImplementerConfig,
} from '../../core/schemas/runner/implementer.js';
import { SOFT_SEP } from '../../core/separators.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import { updateActiveRunner } from '../../core/config/accessors/active-runner.js';
import {
  seatPickerLane,
  type ActiveRunnerRole,
  type PlannerTierRole,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import { seatEffortChannel } from '../../core/runners/capabilities.js';
import { unusedEffortReason } from '../../core/runners/effort-channel.js';
import { TOOL_EFFORT_LADDERS } from '../../core/providers/known-models.js';
import {
  getRunnerCatalogDisplayName,
  type RunnerConfig,
} from '../../core/config/accessors/runner-config.js';
import { EFFORT_LEVELS, type EffortLevel } from '../../core/schemas/enums.js';
import { includes } from '../../utils/type-guards.js';
import type { RunnerPickerOption } from './model-catalog/options.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { fallbackRunner, seatFallback } from '../../core/crew/fallback.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import { configError } from '../../core/config/errors.js';

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
  return `Effort ${effort} cleared: ${unusedEffortReason(runner)}`;
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

function decideEffort<T extends PlannerConfig | ImplementerConfig>(
  input: Readonly<{
    next: T;
    requested: string | null | undefined;
    carried: EffortLevel | undefined;
    effortChoices: readonly string[] | undefined;
    effortChoicesFromFloor: boolean | undefined;
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
    // The model's own ladder rejects a level it does not list; an unanswered one keeps it.
    // The floor of an open tool (Command Code, Codex) only orders the offer, so it rejects
    // nothing. A rung the schema cannot spell is outside every ladder there is.
    const openFloor =
      input.effortChoicesFromFloor === true &&
      next.kind === 'cli' &&
      TOOL_EFFORT_LADDERS[next.tool]?.exhaustive === false;
    if (
      !includes(EFFORT_LEVELS, effort) ||
      (!openFloor && input.effortChoices !== undefined && !input.effortChoices.includes(effort))
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
  // No floor of an open tool reaches here: the open ones are command-code's and codex's, and
  // both spend their effort on a flag, never on a variant.
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

function commitRunnerSelection<T extends RunnerConfig>(
  input: Readonly<{
    role: ActiveRunnerRole;
    existing: RunnerConfig | undefined;
    selection: RunnerPickerOption;
    model: { id: string } | null;
    effort?: string | null | undefined;
    effortChoices?: readonly string[] | undefined;
    effortChoicesFromFloor?: boolean | undefined;
    parse: (value: unknown) => T;
  }>,
): Readonly<{ runner: T; notice?: string; kept?: string }> {
  const { role, existing, parse } = input;
  const opts = {
    kind: input.selection.kind,
    tool: input.selection.id,
    ...(input.model !== null && { model: input.model.id }),
    existing,
  };
  const next = parse(
    role === 'implementer' ? buildRunnerConfig('implementer', opts) : buildRunnerConfig(role, opts),
  );
  const drafted = draftedLevel(next, role, input.effort);
  const effort = decideEffort({
    next,
    requested: drafted.effort,
    carried: existing?.effort,
    effortChoices: input.effortChoices,
    effortChoicesFromFloor: input.effortChoicesFromFloor,
    role,
    parse,
  });
  const variant = decideVariant({
    next: effort.runner,
    requested: drafted.variant,
    carried: existing?.variant,
    carriedModel: existing?.model,
    effortChoices: input.effortChoices,
    role,
    parse,
  });
  const notice = joinNotices(effort.notice, variant.notice);
  const kept = variant.runner.variant ?? variant.runner.effort;
  return {
    runner: variant.runner,
    ...(notice !== undefined && { notice }),
    ...(kept !== undefined && { kept }),
  };
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
  /** The ladder is the tool's floor, not one the model published. */
  effortChoicesFromFloor?: boolean | undefined;
}

export function commitPlannerTierSelection(input: PlannerTierSelectionInput): SeatCommitResult {
  let notice: string | undefined;
  let kept: string | undefined;
  const parse = (value: unknown) => PlannerConfigSchema.parse(value);
  const config = updatePlannerTier(input.config, input.role, (existing) => {
    const committed = commitRunnerSelection({
      ...input,
      existing,
      parse,
    });
    notice = committed.notice;
    kept = committed.kept;
    return committed.runner;
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
  /** The ladder is the tool's floor, not one the model published. */
  effortChoicesFromFloor?: boolean | undefined;
  /** The BUILD profile the save lands on; absent is the default profile. */
  profile?: string | undefined;
}

export function commitImplementerSelection(input: ImplementerSelectionInput): SeatCommitResult {
  let notice: string | undefined;
  let kept: string | undefined;
  const parse = (value: unknown) => ImplementerConfigSchema.parse(value);
  const updated = updateActiveRunner({
    config: input.config,
    role: 'implementer',
    profile: input.profile,
    updater: (existing) => {
      const committed = commitRunnerSelection({
        ...input,
        role: 'implementer',
        existing,
        parse,
      });
      notice = committed.notice;
      kept = committed.kept;
      return committed.runner;
    },
  });
  return {
    config: updated,
    ...(notice !== undefined && { notice }),
    ...(kept !== undefined && { effort: kept }),
  };
}

export function commitFallbackSelection(
  input: Readonly<{
    config: Config;
    role: ActiveRunnerRole;
    selection: RunnerPickerOption;
    model: { id: string } | null;
    effort?: string | null | undefined;
    effortChoices?: readonly string[] | undefined;
    effortChoicesFromFloor?: boolean | undefined;
  }>,
): SeatCommitResult {
  const current = seatFallback(input.config, input.role);
  const committed = commitRunnerSelection({
    ...input,
    existing: current === undefined ? undefined : fallbackRunner(current),
    parse: (value) =>
      input.role === 'implementer'
        ? ImplementerConfigSchema.parse(value)
        : PlannerConfigSchema.parse(value),
  });
  const runner = committed.runner;
  if (runner.kind !== 'cli') {
    throw configError.invalidOverride('fallback', runner.kind, 'A fallback must name a CLI tool');
  }
  const fallback = {
    tool: runner.tool,
    ...(runner.model !== undefined &&
      !isAutomaticModel(runner.model, runner.tool) && { model: runner.model }),
    ...(runner.effort !== undefined && { effort: runner.effort }),
    ...(runner.variant !== undefined && { variant: runner.variant }),
  };
  const updater = <T extends RunnerConfig>(seat: T): T => ({ ...seat, fallback });
  const config = updateActiveRunner({ config: input.config, role: input.role, updater });
  return {
    config,
    ...(committed.notice !== undefined && { notice: committed.notice }),
    ...(committed.kept !== undefined && { effort: committed.kept }),
  };
}

export function clearSeatFallback(config: Config, role: ActiveRunnerRole): Config {
  return updateActiveRunner({
    config,
    role,
    updater: <T extends RunnerConfig>(seat: T): T => {
      const runner = { ...seat };
      delete runner.fallback;
      return runner;
    },
  });
}

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
