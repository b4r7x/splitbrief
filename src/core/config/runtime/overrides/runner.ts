import { buildRunnerConfig, inferKindFromTool, type BuildRunnerOpts } from '../build-runner.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { getProviderDisplayName } from '../../../providers/catalog.js';
import { isCliToolId } from '../../../runners/cli-tool-catalog.js';
import { runnerEffortChannel, unusedEffortReason } from '../../../runners/effort-channel.js';
import type { RunnerKind } from '../../../schemas/enums.js';
import type { Config } from '../../../schemas/config.js';
import type { PlannerConfig } from '../../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../../schemas/implementer-config.js';
import type { EffortLevel } from '../../../schemas/enums.js';
import type { ActiveRunnerRole } from '../../../runners/seat-roles.js';
import {
  mergeImplementerProfileMetadata,
  pickDefaultProfileName,
  stripProfileMetadata,
} from '../../accessors/implementer-profiles.js';
import type { ReviewerConfig } from '../../../schemas/reviewer-config.js';
import type { RunnerConfig } from '../../accessors/runner-config.js';
import { readActiveRunner } from '../../accessors/active-runner.js';
import { resolveReviewerRunner } from '../../accessors/reviewer-runner.js';
import { configError } from '../../errors.js';

import type { RunnerOverrides } from './schema.js';

export function existingToOpts(existing: PlannerConfig | ImplementerConfig): BuildRunnerOpts {
  const common: BuildRunnerOpts = {
    ...(existing.model !== undefined && { model: existing.model }),
    ...(existing.timeout !== undefined && { timeout: existing.timeout }),
    ...(existing.customModels !== undefined && { customModels: existing.customModels }),
    ...(existing.effort !== undefined && { effort: existing.effort }),
    ...(existing.variant !== undefined && { variant: existing.variant }),
    ...('idleWarnMs' in existing &&
      existing.idleWarnMs !== undefined && { idleWarnMs: existing.idleWarnMs }),
    ...('idleKillMs' in existing &&
      existing.idleKillMs !== undefined && { idleKillMs: existing.idleKillMs }),
    ...('maxToolCalls' in existing &&
      existing.maxToolCalls !== undefined && { maxToolCalls: existing.maxToolCalls }),
  };

  if (existing.kind === 'cli') {
    return {
      ...common,
      kind: 'cli',
      tool: existing.tool,
      ...('args' in existing && { args: existing.args }),
      ...('outputFormat' in existing && { outputFormat: existing.outputFormat }),
    };
  }
  if (existing.kind === 'api') {
    return {
      ...common,
      kind: 'api',
      tool: existing.provider,
      service: existing.service,
      offering: existing.offering,
      apiBase: existing.apiBase,
      ...('apiKey' in existing && { apiKey: existing.apiKey }),
    };
  }
  if (existing.kind === 'shell' || existing.kind === 'agent') {
    return {
      ...common,
      kind: existing.kind,
      command: existing.command,
      ...('args' in existing && { args: existing.args }),
      ...('outputFormat' in existing && { outputFormat: existing.outputFormat }),
      ...('capabilities' in existing && { capabilities: existing.capabilities }),
    };
  }
  return assertNever(existing);
}

export const REMOVE_FLAG_FIX = 'Remove the flag from the command.';

/** An input that its seat does not use: the notice, and the fix that removes the input. */
export type IgnoredFlag = Readonly<{ notice: string; fix: string }>;

/** An effort input as the user typed it: the name that its notice starts with, and its fix. */
export type EffortInput = Readonly<{ name: string; fix: string }>;

/** The config the flags give, and each flag that its seat does not use. */
export type AppliedOverrides = { config: Config; ignoredFlags: IgnoredFlag[] };

type BuiltRunner<T> = { runner: T | undefined; ignoredFlags: IgnoredFlag[] };

export function applyRunnerOverrides(
  role: ActiveRunnerRole,
  overrides: RunnerOverrides,
  config: Config,
): AppliedOverrides {
  switch (role) {
    case 'planner': {
      const { runner, ignoredFlags } = buildRunnerFromOverrides(
        'planner',
        overrides,
        config.planner,
      );
      return {
        config: runner === undefined ? config : { ...config, planner: runner },
        ignoredFlags,
      };
    }
    case 'reviewer': {
      const { runner, ignoredFlags } = buildRunnerFromOverrides(
        'reviewer',
        overrides,
        readActiveRunner({ config, role: 'reviewer' }),
      );
      return {
        config: runner === undefined ? config : { ...config, reviewer: runner },
        ignoredFlags,
      };
    }
    case 'implementer': {
      const { runner, ignoredFlags } = buildRunnerFromOverrides(
        'implementer',
        overrides,
        config.implementer,
      );
      return {
        config: runner === undefined ? config : { ...config, implementer: runner },
        ignoredFlags,
      };
    }
    default:
      return assertNever(role);
  }
}

function unusableProviderFlags(input: {
  role: ActiveRunnerRole;
  kind: RunnerKind;
  tool: string | undefined;
  apiBase: string | undefined;
  apiKey: string | undefined;
}): IgnoredFlag[] {
  const { role, kind, tool, apiBase, apiKey } = input;
  if (kind === 'api') return [];
  // A CLI tool id always selects the CLI in flags, so an API-only flag is
  // ignored. Name the identity the name resolved to and the only route to an
  // API provider of that name, so the collision is not a silent kind change.
  const reason =
    tool !== undefined && isCliToolId(tool)
      ? `'${tool}' selects the ${getProviderDisplayName(tool)} runner, which does not use it; a custom API provider with this name must set ${role}.kind: api in splitbrief.yaml`
      : `the ${role} '${kind}' runner does not use it`;
  return [
    ...(apiKey !== undefined ? [`--${role}-api-key-env is ignored: ${reason}.`] : []),
    ...(apiBase !== undefined ? [`--${role}-api-base is ignored: ${reason}.`] : []),
  ].map((notice) => ({ notice, fix: REMOVE_FLAG_FIX }));
}

function buildRunnerFromOverrides(
  role: 'planner',
  overrides: RunnerOverrides,
  existing: PlannerConfig,
): BuiltRunner<PlannerConfig>;
function buildRunnerFromOverrides(
  role: 'implementer',
  overrides: RunnerOverrides,
  existing: ImplementerConfig,
): BuiltRunner<ImplementerConfig>;
function buildRunnerFromOverrides(
  role: 'reviewer',
  overrides: RunnerOverrides,
  existing: ReviewerConfig,
): BuiltRunner<ReviewerConfig>;
function buildRunnerFromOverrides(
  role: ActiveRunnerRole,
  overrides: RunnerOverrides,
  existing: PlannerConfig | ImplementerConfig,
): BuiltRunner<PlannerConfig | ImplementerConfig> {
  const { tool, model, command, apiBase, apiKey, args, outputFormat, contextLength } = overrides;
  const baseOpts =
    tool !== undefined
      ? { kind: inferKindFromTool(tool), tool }
      : command !== undefined
        ? { kind: 'shell' as const }
        : existingToOpts(existing);
  const kind = baseOpts.kind ?? existing.kind;
  const ignoredFlags = unusableProviderFlags({ role, kind, tool, apiBase, apiKey });
  const applies =
    tool !== undefined ||
    model !== undefined ||
    command !== undefined ||
    args !== undefined ||
    outputFormat !== undefined ||
    contextLength !== undefined ||
    ((apiBase !== undefined || apiKey !== undefined) && kind === 'api');
  if (!applies) return { runner: undefined, ignoredFlags };

  const opts: BuildRunnerOpts = {
    ...baseOpts,
    ...(model !== undefined && { model }),
    ...(command !== undefined && { command }),
    ...(apiBase !== undefined && { apiBase }),
    ...(apiKey !== undefined && { apiKey }),
    ...(args !== undefined && { args }),
    ...(outputFormat !== undefined && { outputFormat }),
    ...(contextLength !== undefined && { contextLength }),
    existing,
  };

  switch (role) {
    case 'implementer':
      return { runner: buildRunnerConfig('implementer', opts), ignoredFlags };
    case 'planner':
      return { runner: buildRunnerConfig('planner', opts), ignoredFlags };
    case 'reviewer':
      return { runner: buildRunnerConfig('reviewer', opts), ignoredFlags };
    default:
      return assertNever(role);
  }
}

export function applyImplementerOverrides(
  overrides: RunnerOverrides,
  config: Config,
): AppliedOverrides {
  const profiles = config.implementerProfiles;
  if (!profiles) return applyRunnerOverrides('implementer', overrides, config);

  const defaultName = pickDefaultProfileName(profiles);
  const defaultProfile = defaultName === undefined ? undefined : profiles.profiles[defaultName];
  if (defaultName === undefined || defaultProfile === undefined) {
    return applyRunnerOverrides('implementer', overrides, config);
  }

  const existing = stripProfileMetadata(defaultProfile);
  const { runner, ignoredFlags } = buildRunnerFromOverrides('implementer', overrides, existing);
  if (runner === undefined) return { config, ignoredFlags };

  return {
    config: {
      ...config,
      implementer: runner,
      implementerProfiles: {
        ...profiles,
        profiles: {
          ...profiles.profiles,
          [defaultName]: mergeImplementerProfileMetadata(defaultProfile, runner),
        },
      },
    },
    ignoredFlags,
  };
}

/** A seat whose tool takes no effort flag keeps its config, and the input is named as ignored. */
function ignoredEffortFlags(input: EffortInput, runner: RunnerConfig): IgnoredFlag[] {
  return runnerEffortChannel(runner) === 'effort-flag'
    ? []
    : [{ notice: `${input.name} is ignored: ${unusedEffortReason(runner)}.`, fix: input.fix }];
}

export function applyPlannerEffort(
  config: Config,
  effort: EffortLevel,
  input: EffortInput,
): AppliedOverrides {
  const ignoredFlags = ignoredEffortFlags(input, config.planner);
  return {
    config:
      ignoredFlags.length > 0 ? config : { ...config, planner: { ...config.planner, effort } },
    ignoredFlags,
  };
}

export function applyReviewerEffort(
  config: Config,
  effort: EffortLevel,
  input: EffortInput,
): AppliedOverrides {
  const seat = resolveReviewerRunner(config);
  if (seat.source === 'none') {
    throw configError.invalidOverride(
      input.name,
      effort,
      'REVIEW is set to None; pass --reviewer to give it a runner first.',
    );
  }
  if (seat.source === 'planner') {
    throw configError.invalidOverride(
      input.name,
      effort,
      'The review seat inherits the planner; pass --reviewer to give it its own runner first.',
    );
  }
  const ignoredFlags = ignoredEffortFlags(input, seat.runner);
  return {
    config: ignoredFlags.length > 0 ? config : { ...config, reviewer: { ...seat.runner, effort } },
    ignoredFlags,
  };
}
