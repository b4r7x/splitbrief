import {
  type RunnerConfig,
  type RunnerConfigSlot,
  getRunnerCatalogDisplayName,
} from '../../../config/accessors/runner-config.js';
import { formatSlotLabel } from '../../../crew/identity.js';
import { resolveCliModel } from '../../../providers/automatic-model.js';
import {
  runnerEffortChannel,
  isOpencode2,
  unusedEffortReason,
} from '../../../runners/effort-channel.js';
import type { Config } from '../../../schemas/config.js';
import type { ReadinessCheck } from '../../types.js';

/**
 * `variant` is a named effort preset the tool takes on its own command line, so
 * only a backend whose declared effort channel IS that flag can deliver one.
 */
function deliversVariant(runner: RunnerConfig): boolean {
  return runnerEffortChannel(runner) === 'variant';
}

const NOT_APPLIED_SUFFIX = '-not-applied';

/** A warning of `droppedRunnerFieldChecks`; with a role, only one that seat's setting gives. */
export function isSettingNotAppliedCheck(
  check: ReadinessCheck,
  role?: RunnerConfigSlot['role'] | undefined,
): boolean {
  return (
    check.id.endsWith(NOT_APPLIED_SUFFIX) && (role === undefined || check.metadata?.role === role)
  );
}

function notAppliedCheck(
  slot: RunnerConfigSlot,
  setting: string,
  summary: string,
  fix: string,
): ReadinessCheck {
  return {
    id: `runners.${slot.role}.${setting}${NOT_APPLIED_SUFFIX}`,
    severity: 'warning',
    summary: `${formatSlotLabel(slot)}: ${summary}.`,
    fix,
    metadata: { ...slot },
  };
}

/** The route a CLI seat calls: its tool's installed release and the model the seat sends. */
export type CliSeatRoute = Readonly<{
  installedVersion: string | undefined;
  model: string | undefined;
}>;

/**
 * OpenCode 2 takes a variant only on the model, so a seat that sends no model
 * sends no variant, and OpenCode runs its own default.
 */
export function variantWithoutModelChecks(
  slot: RunnerConfigSlot,
  runner: RunnerConfig,
  route: CliSeatRoute,
): ReadinessCheck[] {
  if (
    runner.kind !== 'cli' ||
    runner.tool !== 'opencode' ||
    runner.variant === undefined ||
    !isOpencode2(route.installedVersion) ||
    resolveCliModel(route.model, runner.tool) !== undefined
  ) {
    return [];
  }
  const seat = formatSlotLabel(slot);
  const tool = getRunnerCatalogDisplayName(runner);
  return [
    notAppliedCheck(
      slot,
      'variant',
      `the variant setting is not applied: ${tool} ${route.installedVersion} takes a variant only with a model`,
      `Choose a model for ${seat} in Settings > Crew > ${seat}, or set a default model in ${tool}.`,
    ),
  ];
}

/** One warning for each generation setting the seat's tool does not apply. BUILD gets no effort warning. */
export function droppedRunnerFieldChecks(
  config: Config,
  slot: RunnerConfigSlot,
  runner: RunnerConfig,
  route: CliSeatRoute,
): ReadinessCheck[] {
  const seat = formatSlotLabel(slot);
  const key =
    slot.role === 'implementer' && config.implementerProfiles?.profiles[slot.profile] !== undefined
      ? `implementerProfiles.profiles.${slot.profile}`
      : slot.role;
  const tool = getRunnerCatalogDisplayName(runner);
  const checks: ReadinessCheck[] = [];
  const notApplied = (setting: string, summary: string, fix: string): void => {
    checks.push(notAppliedCheck(slot, setting, summary, fix));
  };

  if (
    slot.role !== 'implementer' &&
    runner.effort !== undefined &&
    runnerEffortChannel(runner) !== 'effort-flag'
  ) {
    notApplied(
      'effort',
      `the effort setting is not applied: ${unusedEffortReason(runner)}`,
      `Delete effort from ${key} in .splitbrief/config.yaml, or choose a tool that takes an effort in Settings > Crew > ${seat}.`,
    );
  }
  if (runner.variant !== undefined && !deliversVariant(runner)) {
    notApplied(
      'variant',
      `the variant setting is not applied: ${tool} has no variant`,
      `Delete variant from ${key} in .splitbrief/config.yaml.`,
    );
  }
  checks.push(...variantWithoutModelChecks(slot, runner, route));
  if (runner.temperature !== undefined && runner.kind !== 'api') {
    notApplied(
      'temperature',
      `the temperature setting is not applied: ${tool} takes no temperature`,
      `Delete temperature from ${key} in .splitbrief/config.yaml.`,
    );
  }
  if (
    (runner.kind === 'shell' || runner.kind === 'agent') &&
    runner.maxToolCalls !== undefined &&
    (runner.outputFormat ?? 'text') === 'text'
  ) {
    notApplied(
      'tool-call-limit',
      'the tool-call limit is not applied: text output reports no tool calls',
      `Set the output format of ${key} to stream-json, or delete the limit, in .splitbrief/config.yaml.`,
    );
  }
  return checks;
}
