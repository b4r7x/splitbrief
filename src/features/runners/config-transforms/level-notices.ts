import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { TOOL_EFFORT_LADDERS } from '../../../core/providers/tool-effort-ladders.js';
import { seatEffortChannel } from '../../../core/runners/capabilities.js';
import { unusedEffortReason } from '../../../core/runners/effort-channel.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { type EffortLevel, EFFORT_LEVELS } from '../../../core/schemas/enums.js';
import type { ImplementerConfig } from '../../../core/schemas/runner/implementer.js';
import type { PlannerConfig } from '../../../core/schemas/runner/planner.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { includes } from '../../../utils/type-guards.js';

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
export function draftedLevel(
  next: PlannerConfig | ImplementerConfig,
  role: ActiveRunnerRole,
  level: string | null | undefined,
): Readonly<{ effort?: string | null; variant?: string | null }> {
  if (level === undefined) return {};
  return seatEffortChannel({ runner: next, role }) === 'effort-flag'
    ? { effort: level }
    : { variant: level };
}

export function decideEffort<T extends PlannerConfig | ImplementerConfig>(
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

export function decideVariant<T extends PlannerConfig | ImplementerConfig>(
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
export function joinNotices(...notices: readonly (string | undefined)[]): string | undefined {
  const lines = notices.filter((line) => line !== undefined);
  return lines.length === 0 ? undefined : lines.join(SOFT_SEP);
}
