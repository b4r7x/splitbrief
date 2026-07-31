import { buildRunnerConfig, inferKindFromTool, type BuildRunnerOpts } from '../build-runner.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { warnStderr } from '../../../../lib/warn.js';
import type { RunnerKind } from '../../../schemas/enums.js';
import type { Config } from '../../../schemas/config.js';
import type { PlannerConfig } from '../../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../../schemas/implementer-config.js';
import type { EffortLevel } from '../../../schemas/enums.js';
import type { CliAuthChannelId } from '../../../runners/cli-tool-catalog.js';
import {
  mergeImplementerProfileMetadata,
  pickDefaultProfileName,
  stripProfileMetadata,
} from '../../accessors/implementer-profiles.js';
import type { RunnerOverrides } from './schema.js';

export function existingToOpts(existing: PlannerConfig | ImplementerConfig): BuildRunnerOpts {
  const common: BuildRunnerOpts = {
    ...(existing.model !== undefined && { model: existing.model }),
    ...(existing.timeout !== undefined && { timeout: existing.timeout }),
    ...(existing.customModels !== undefined && { customModels: existing.customModels }),
    ...(existing.effort !== undefined && { effort: existing.effort }),
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
  if (existing.kind === 'agent-sdk') {
    return {
      ...common,
      kind: 'agent-sdk',
      ...('apiKey' in existing && { apiKey: existing.apiKey }),
    };
  }
  return assertNever(existing);
}

export function applyRunnerOverrides(
  role: 'planner' | 'implementer',
  overrides: RunnerOverrides,
  config: Config,
): Config {
  if (role === 'planner') {
    const updated = buildRunnerFromOverrides('planner', overrides, config.planner);
    return updated === undefined ? config : { ...config, planner: updated };
  }

  const updated = buildRunnerFromOverrides('implementer', overrides, config.implementer);
  return updated === undefined ? config : { ...config, implementer: updated };
}

function warnUnusableProviderOverrides(
  role: 'planner' | 'implementer',
  kind: RunnerKind,
  apiBase: string | undefined,
  apiKey: string | undefined,
): void {
  const usesApiKey = kind === 'api' || kind === 'agent-sdk';
  const usesApiBase = kind === 'api';
  if (apiKey !== undefined && !usesApiKey) {
    warnStderr(`--${role}-api-key-env is ignored: the ${role} '${kind}' runner does not use it.`);
  }
  if (apiBase !== undefined && !usesApiBase) {
    warnStderr(`--${role}-api-base is ignored: the ${role} '${kind}' runner does not use it.`);
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
  role: 'planner' | 'implementer',
  overrides: RunnerOverrides,
  existing: PlannerConfig | ImplementerConfig,
): PlannerConfig | ImplementerConfig | undefined {
  const { tool, model, command, apiBase, apiKey, args, outputFormat, contextLength } = overrides;
  if (
    tool === undefined &&
    model === undefined &&
    command === undefined &&
    apiBase === undefined &&
    apiKey === undefined &&
    args === undefined &&
    outputFormat === undefined &&
    contextLength === undefined
  ) {
    return undefined;
  }

  const baseOpts =
    tool !== undefined
      ? { kind: inferKindFromTool(tool), tool }
      : command !== undefined
        ? { kind: 'shell' as const }
        : apiBase !== undefined && existing.kind !== 'api'
          ? { kind: 'api' as const }
          : existingToOpts(existing);
  warnUnusableProviderOverrides(role, baseOpts.kind ?? existing.kind, apiBase, apiKey);
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

  return role === 'planner'
    ? buildRunnerConfig('planner', opts)
    : buildRunnerConfig('implementer', opts);
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
