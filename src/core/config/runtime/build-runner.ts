import { includes, assertNever } from '../../../utils/type-guards.js';
import { resolveDefaultApiBase } from '../../providers/catalog.js';
import { getApiProviderDescriptor } from '../../providers/api-catalog.js';
import { normalizeProviderEndpoint } from '../../providers/endpoint-policy.js';
import {
  CLI_TOOL_IDS,
  cliModelPolicyViolations,
  getCliModelPolicy,
  LISTED_CLI_TOOL_IDS,
} from '../../runners/cli-tool/catalog.js';
import {
  runnerRoleForActiveRole,
  type ActiveRunnerRole,
  type PlannerTierRole,
} from '../../runners/seat-roles.js';
import { PlannerConfigSchema } from '../../schemas/runner/planner.js';
import { ImplementerConfigSchema } from '../../schemas/runner/implementer.js';
import { ReviewerConfigSchema } from '../../schemas/runner/reviewer.js';
import { configError } from '../errors.js';
import type { PlannerConfig } from '../../schemas/runner/planner.js';
import type { ImplementerConfig } from '../../schemas/runner/implementer.js';
import type { RunnerKind } from '../../schemas/enums.js';
import type { BuildRunnerOpts } from './types.js';
import {
  carriedSeatSettings,
  destinationValue,
  existingAtTarget,
  existingPlannerCapabilities,
  resolveGenerationParams,
  resolveWatchdogs,
  spreadFallback,
  spreadGenParams,
  spreadWatchdogs,
  targetState,
} from './carried-settings.js';

export function buildRunnerConfig(role: PlannerTierRole, opts: BuildRunnerOpts): PlannerConfig;
export function buildRunnerConfig(role: 'implementer', opts: BuildRunnerOpts): ImplementerConfig;
export function buildRunnerConfig(
  role: ActiveRunnerRole,
  opts: BuildRunnerOpts,
): PlannerConfig | ImplementerConfig {
  const kind = inferKind(role, opts);
  switch (kind) {
    case 'cli':
      return buildCliConfig(role, opts);
    case 'api':
      return buildApiConfig(role, opts);
    case 'shell':
      return buildCommandConfig(role, opts, 'shell');
    case 'agent':
      return buildCommandConfig(role, opts, 'agent');
    default:
      return assertNever(kind);
  }
}

function assertModelPresent(
  role: ActiveRunnerRole,
  kind: RunnerKind,
  model: string | undefined,
): void {
  if (role === 'implementer' && kind !== 'cli' && !model) {
    throw configError.runnerMissingModel(role);
  }
}

/**
 * Name-only kind inference for flags. A CLI tool id always means the CLI, and API-only
 * flags never flip the inferred kind: a custom API provider that reuses a CLI tool's
 * name is configurable in YAML only. `inferKind` applies an explicit kind first.
 */
export function inferKindFromTool(tool: string): RunnerKind {
  if (tool === 'shell') return 'shell';
  if (tool === 'agent') return 'agent';
  if (includes(CLI_TOOL_IDS, tool)) return 'cli';
  return 'api';
}

function inferKind(role: ActiveRunnerRole, opts: BuildRunnerOpts): RunnerKind {
  if (opts.kind) return opts.kind;
  if (opts.tool) return inferKindFromTool(opts.tool);
  if (opts.apiBase) return 'api';
  if (opts.command) return 'shell';
  if (opts.existing?.kind) return opts.existing.kind;
  throw configError.runnerKindIndeterminate(role, opts);
}

function parseRunnerConfig(
  role: ActiveRunnerRole,
  config: Record<string, unknown>,
): PlannerConfig | ImplementerConfig {
  switch (role) {
    case 'implementer':
      return ImplementerConfigSchema.parse(config);
    case 'reviewer':
      return ReviewerConfigSchema.parse(config);
    case 'planner':
      return PlannerConfigSchema.parse(config);
    default:
      return assertNever(role);
  }
}

function getExistingApiBase(
  existing: PlannerConfig | ImplementerConfig | undefined,
  provider: string,
): string | undefined {
  return existing?.kind === 'api' && existing.provider === provider ? existing.apiBase : undefined;
}

function getDescriptorApiBase(provider: string): string | undefined {
  const descriptor = getApiProviderDescriptor(provider);
  if (descriptor?.endpointPolicy.kind === 'fixed-origin') {
    return descriptor.endpointPolicy.baseURL;
  }
  if (descriptor?.endpointPolicy.kind === 'loopback') {
    return descriptor.endpointPolicy.defaultBaseURL;
  }
  return resolveDefaultApiBase(provider) ?? undefined;
}

function getExistingApiKey(
  existing: PlannerConfig | ImplementerConfig | undefined,
  provider: string,
): string | undefined {
  if (existing?.kind !== 'api') return undefined;
  return existing.provider === provider ? existing.apiKey : undefined;
}

function buildCliConfig(
  role: ActiveRunnerRole,
  opts: BuildRunnerOpts,
): PlannerConfig | ImplementerConfig {
  const tool = opts.tool ?? (opts.existing?.kind === 'cli' ? opts.existing.tool : undefined);
  if (!tool) throw configError.runnerMissingField({ role, kind: 'cli', field: 'tool' });
  if (!includes(CLI_TOOL_IDS, tool)) {
    throw configError.unknownCliTool(tool, LISTED_CLI_TOOL_IDS);
  }

  const target = { kind: 'cli' as const, id: tool };
  const carried = carriedSeatSettings(opts.existing, target);
  const gen = resolveGenerationParams(opts, target, carried);
  const modelPolicy = getCliModelPolicy(tool, runnerRoleForActiveRole(role));
  const modelViolation = cliModelPolicyViolations(modelPolicy, gen)[0];
  if (modelViolation !== undefined) {
    if (modelPolicy === 'required' && gen.model === undefined) {
      throw configError.runnerMissingModel(role);
    }
    throw configError.invalidOverride(
      modelViolation.field,
      gen[modelViolation.field],
      modelViolation.message,
    );
  }
  const args = opts.args ?? carried.args;
  const outputFormat = opts.outputFormat ?? carried.outputFormat;
  const config: Record<string, unknown> = {
    kind: 'cli',
    tool,
    ...(args !== undefined && { args }),
    ...(outputFormat !== undefined && { outputFormat }),
    ...spreadWatchdogs(resolveWatchdogs(opts, carried)),
    ...spreadGenParams(gen),
    ...spreadFallback(opts.existing),
  };

  return parseRunnerConfig(role, config);
}

function buildApiConfig(
  role: ActiveRunnerRole,
  opts: BuildRunnerOpts,
): PlannerConfig | ImplementerConfig {
  const provider =
    opts.tool ??
    (opts.existing?.kind === 'api'
      ? opts.existing.provider
      : role === 'implementer'
        ? 'ollama'
        : 'anthropic');
  const target = { kind: 'api' as const, id: provider };
  const existing = existingAtTarget(opts, target);
  const state = targetState(opts, target);
  const descriptor = getApiProviderDescriptor(provider);
  const requestedApiBase = destinationValue(
    state,
    opts.apiBase,
    opts.existing?.kind === 'api' ? opts.existing.apiBase : undefined,
  );
  const existingApiBase = getExistingApiBase(opts.existing, provider);
  const resolvedApiBase = requestedApiBase ?? existingApiBase ?? getDescriptorApiBase(provider);

  if (!resolvedApiBase) {
    throw configError.unknownProvider(provider);
  }
  const apiBase = descriptor
    ? normalizeProviderEndpoint(descriptor.endpointPolicy, resolvedApiBase)
    : resolvedApiBase;

  const sourceApiKey =
    opts.existing !== undefined && 'apiKey' in opts.existing ? opts.existing.apiKey : undefined;
  const requestedApiKey = destinationValue(state, opts.apiKey, sourceApiKey);
  const existingApiKey = state === 'same' ? getExistingApiKey(opts.existing, provider) : undefined;
  const gen = resolveGenerationParams(opts, target, carriedSeatSettings(opts.existing, target));
  assertModelPresent(role, 'api', gen.model);
  const apiKey = requestedApiKey ?? existingApiKey;
  const service =
    descriptor?.service ?? opts.service ?? (existing?.kind === 'api' ? existing.service : provider);
  const offering =
    descriptor?.offering ??
    opts.offering ??
    (existing?.kind === 'api' ? existing.offering : 'payg');

  const config: Record<string, unknown> = {
    kind: 'api',
    provider,
    ...(service !== undefined && { service }),
    ...(offering !== undefined && { offering }),
    apiBase,
    ...(apiKey !== undefined && { apiKey }),
    ...spreadGenParams(gen),
    ...spreadFallback(opts.existing),
  };

  return parseRunnerConfig(role, config);
}

function buildCommandConfig(
  role: ActiveRunnerRole,
  opts: BuildRunnerOpts,
  kind: 'shell' | 'agent',
): PlannerConfig | ImplementerConfig {
  const command =
    opts.command ?? (opts.existing?.kind === kind ? opts.existing.command : undefined);
  if (!command) throw configError.runnerMissingField({ role, kind, field: 'command' });

  const target = { kind, id: command };
  const existing = existingAtTarget(opts, target);
  const carried = carriedSeatSettings(opts.existing, target);
  const gen = resolveGenerationParams(opts, target, carried);
  const args = opts.args ?? carried.args;
  const outputFormat = opts.outputFormat ?? carried.outputFormat;
  const capabilities =
    targetState(opts, target) === 'changed'
      ? undefined
      : (opts.capabilities ?? existingPlannerCapabilities(existing));
  assertModelPresent(role, kind, gen.model);

  const config: Record<string, unknown> = {
    kind,
    command,
    ...(args !== undefined && { args }),
    ...(outputFormat !== undefined && { outputFormat }),
    ...(capabilities !== undefined && { capabilities }),
    ...spreadWatchdogs(resolveWatchdogs(opts, carried)),
    ...spreadGenParams(gen),
    ...spreadFallback(opts.existing),
  };

  return parseRunnerConfig(role, config);
}
