import { buildRunnerConfig, inferKindFromTool, type BuildRunnerOpts } from '../build-runner.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { warnStderr } from '../../../../lib/warn.js';
import { getProviderDisplayName } from '../../../providers/catalog.js';
import { isCliToolId } from '../../../runners/cli-tool-catalog.js';
import type { RunnerKind } from '../../../schemas/enums.js';
import type { Config } from '../../../schemas/config.js';
import type { PlannerConfig } from '../../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../../schemas/implementer-config.js';
import type { EffortLevel } from '../../../schemas/enums.js';
import type { CliAuthChannelId } from '../../../runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../../runners/seat-roles.js';
import {
  mergeImplementerProfileMetadata,
  pickDefaultProfileName,
  stripProfileMetadata,
} from '../../accessors/implementer-profiles.js';
import type { ReviewerConfig } from '../../../schemas/reviewer-config.js';
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
  };

  if (existing.kind === 'cli') {
    return {
      ...common,
      kind: 'cli',
      tool: existing.tool,
      ...(existing.authChannel !== undefined && {
        authChannel: existing.authChannel satisfies CliAuthChannelId,
      }),
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

export function applyRunnerOverrides(
  role: ActiveRunnerRole,
  overrides: RunnerOverrides,
  config: Config,
): Config {
  switch (role) {
    case 'planner': {
      const updated = buildRunnerFromOverrides('planner', overrides, config.planner);
      return updated === undefined ? config : { ...config, planner: updated };
    }
    case 'reviewer': {
      const seat = resolveReviewerRunner(config);
      const updated = buildRunnerFromOverrides('reviewer', overrides, seat.runner);
      return updated === undefined ? config : { ...config, reviewer: updated };
    }
    case 'implementer': {
      const updated = buildRunnerFromOverrides('implementer', overrides, config.implementer);
      return updated === undefined ? config : { ...config, implementer: updated };
    }
    default:
      return assertNever(role);
  }
}

function warnUnusableProviderOverrides(input: {
  role: ActiveRunnerRole;
  kind: RunnerKind;
  tool: string | undefined;
  apiBase: string | undefined;
  apiKey: string | undefined;
}): void {
  const { role, kind, tool, apiBase, apiKey } = input;
  if (kind === 'api') return;
  // A CLI tool id always selects the CLI in flags, so an API-only flag is
  // ignored. Name the identity the name resolved to and the only route to an
  // API provider of that name, so the collision is not a silent kind change.
  const reason =
    tool !== undefined && isCliToolId(tool)
      ? `'${tool}' selects the ${getProviderDisplayName(tool)} runner, which does not use it; a custom API provider with this name must set ${role}.kind: api in splitbrief.yaml`
      : `the ${role} '${kind}' runner does not use it`;
  if (apiKey !== undefined) {
    warnStderr(`--${role}-api-key-env is ignored: ${reason}.`);
  }
  if (apiBase !== undefined) {
    warnStderr(`--${role}-api-base is ignored: ${reason}.`);
  }
}

function buildRunnerFromOverrides(
  role: 'planner',
  overrides: RunnerOverrides,
  existing: PlannerConfig,
): PlannerConfig | undefined;
function buildRunnerFromOverrides(
  role: 'implementer',
  overrides: RunnerOverrides,
  existing: ImplementerConfig,
): ImplementerConfig | undefined;
function buildRunnerFromOverrides(
  role: 'reviewer',
  overrides: RunnerOverrides,
  existing: ReviewerConfig,
): ReviewerConfig | undefined;
function buildRunnerFromOverrides(
  role: ActiveRunnerRole,
  overrides: RunnerOverrides,
  existing: PlannerConfig | ImplementerConfig,
): PlannerConfig | ImplementerConfig | undefined {
  const { tool, model, command, apiBase, apiKey, args, outputFormat, contextLength } = overrides;
  const baseOpts =
    tool !== undefined
      ? { kind: inferKindFromTool(tool), tool }
      : command !== undefined
        ? { kind: 'shell' as const }
        : apiBase !== undefined && existing.kind !== 'api'
          ? { kind: 'api' as const }
          : existingToOpts(existing);
  const kind = baseOpts.kind ?? existing.kind;
  warnUnusableProviderOverrides({ role, kind, tool, apiBase, apiKey });
  const applies =
    tool !== undefined ||
    model !== undefined ||
    command !== undefined ||
    apiBase !== undefined ||
    args !== undefined ||
    outputFormat !== undefined ||
    contextLength !== undefined ||
    (apiKey !== undefined && kind === 'api');
  if (!applies) return undefined;

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
      return buildRunnerConfig('implementer', opts);
    case 'planner':
      return buildRunnerConfig('planner', opts);
    case 'reviewer':
      return buildRunnerConfig('reviewer', opts);
    default:
      return assertNever(role);
  }
}

export function applyImplementerOverrides(overrides: RunnerOverrides, config: Config): Config {
  const profiles = config.implementerProfiles;
  if (!profiles) return applyRunnerOverrides('implementer', overrides, config);

  const defaultName = pickDefaultProfileName(profiles);
  const defaultProfile = defaultName === undefined ? undefined : profiles.profiles[defaultName];
  if (defaultName === undefined || defaultProfile === undefined) {
    return applyRunnerOverrides('implementer', overrides, config);
  }

  const existing = stripProfileMetadata(defaultProfile);
  const updated = buildRunnerFromOverrides('implementer', overrides, existing);
  if (updated === undefined) return config;

  return {
    ...config,
    implementer: updated,
    implementerProfiles: {
      ...profiles,
      profiles: {
        ...profiles.profiles,
        [defaultName]: mergeImplementerProfileMetadata(defaultProfile, updated),
      },
    },
  };
}

export function applyPlannerEffort(config: Config, effort: EffortLevel): Config {
  return { ...config, planner: { ...config.planner, effort } };
}

export function applyReviewerEffort(config: Config, effort: EffortLevel): Config {
  const seat = resolveReviewerRunner(config);
  if (seat.source === 'planner') {
    throw configError.invalidOverride(
      '--reviewer-effort',
      effort,
      'The review seat inherits the planner; pass --reviewer to give it its own runner first.',
    );
  }
  return { ...config, reviewer: { ...seat.runner, effort } };
}
