import { updateActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { configError } from '../../../core/config/errors.js';
import { buildRunnerConfig } from '../../../core/config/runtime/build-runner.js';
import { seatFallback, fallbackRunner } from '../../../core/crew/fallback.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import {
  type PlannerTierRole,
  type SeatPickerRole,
  seatPickerLane,
  type ActiveRunnerRole,
} from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import { ImplementerConfigSchema } from '../../../core/schemas/runner/implementer.js';
import { type PlannerConfig, PlannerConfigSchema } from '../../../core/schemas/runner/planner.js';
import type { RunnerPickerOption } from '../model-catalog/options.js';
import { draftedLevel, decideEffort, decideVariant, joinNotices } from './level-notices.js';

/** The planner-tier seats share the planner's runner shape; only the config node differs. */
export function updatePlannerTier(
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
