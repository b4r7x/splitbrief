import { CLI_TOOL_IDS, KNOWN_API_PROVIDERS } from '../../schemas/enums.js';
import { includes, assertNever } from '../../../utils/type-guards.js';
import { resolveDefaultApiBase } from '../../providers/catalog.js';
import { API_PROVIDER_CATALOG } from '../../providers/api-provider-catalog.js';
import { normalizeProviderEndpoint } from '../../providers/endpoint-policy.js';
import {
  cliModelPolicyViolations,
  getCliModelPolicy,
  type CliAuthChannelId,
} from '../../runners/cli-tool-catalog.js';
import { PlannerConfigSchema } from '../../schemas/planner-config.js';
import { ImplementerConfigSchema } from '../../schemas/implementer-config.js';
import { configError } from '../errors.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { ApiOffering } from '../../providers/api-provider-catalog.js';
import type { EffortLevel, RunnerKind } from '../../schemas/enums.js';
import type { OutputFormat } from '../../schemas/enums.js';

export type Role = 'planner' | 'implementer';

export interface BuildRunnerOpts {
  kind?: RunnerKind | undefined;
  tool?: string | undefined; // cli: tool id; api: provider name
  authChannel?: CliAuthChannelId | undefined;
  model?: string | undefined;
  apiBase?: string | undefined;
  apiKey?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  contextLength?: number | undefined;
  temperature?: number | undefined;
  timeout?: number | undefined;
  customModels?: string[] | undefined;
  effort?: EffortLevel | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  capabilities?: PlannerCapabilities | undefined;
  service?: string | undefined;
  offering?: ApiOffering | undefined;
  existing?: PlannerConfig | ImplementerConfig | undefined;
}

type PlannerCapabilities = Extract<PlannerConfig, { kind: 'shell' }>['capabilities'];

export function buildRunnerConfig(role: 'planner', opts: BuildRunnerOpts): PlannerConfig;
export function buildRunnerConfig(role: 'implementer', opts: BuildRunnerOpts): ImplementerConfig;
export function buildRunnerConfig(
  role: Role,
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
    case 'agent-sdk':
      return buildAgentSdkConfig(role, opts);
    default:
      return assertNever(kind);
  }
}

interface GenerationParams {
  model?: string | undefined;
  contextLength?: number | undefined;
  temperature?: number | undefined;
  timeout?: number | undefined;
  customModels?: string[] | undefined;
  effort?: EffortLevel | undefined;
}

interface RunnerTarget {
  kind: RunnerKind;
  id?: string | undefined;
}

type TargetState = 'new' | 'same' | 'changed';

function existingTargetId(existing: PlannerConfig | ImplementerConfig): string | undefined {
  switch (existing.kind) {
    case 'cli':
      return existing.tool;
    case 'api':
      return existing.provider;
    case 'shell':
    case 'agent':
      return existing.command;
    case 'agent-sdk':
      return undefined;
    default:
      return assertNever(existing);
  }
}

function existingAtTarget(
  opts: BuildRunnerOpts,
  target: RunnerTarget,
): PlannerConfig | ImplementerConfig | undefined {
  const existing = opts.existing;
  return existing !== undefined &&
    existing.kind === target.kind &&
    existingTargetId(existing) === target.id
    ? existing
    : undefined;
}

function targetState(opts: BuildRunnerOpts, target: RunnerTarget): TargetState {
  if (opts.existing === undefined) return 'new';
  return existingAtTarget(opts, target) === undefined ? 'changed' : 'same';
}

function destinationValue<T>(
  state: TargetState,
  requested: T | undefined,
  source: T | undefined,
): T | undefined {
  if (state !== 'changed') return requested ?? source;
  return requested === source ? undefined : requested;
}

function resolveGenerationParams(opts: BuildRunnerOpts, target: RunnerTarget): GenerationParams {
  const ex = opts.existing;
  const sameTarget = existingAtTarget(opts, target);
  const state = targetState(opts, target);

  return {
    model: state === 'changed' ? opts.model : (opts.model ?? sameTarget?.model),
    contextLength: opts.contextLength ?? sameTarget?.contextLength,
    temperature: opts.temperature ?? sameTarget?.temperature,
    timeout: opts.timeout ?? ex?.timeout,
    customModels:
      state === 'changed' ? opts.customModels : (opts.customModels ?? sameTarget?.customModels),
    effort: state === 'changed' ? undefined : (opts.effort ?? sameTarget?.effort),
  };
}

function spreadGenParams(gen: ReturnType<typeof resolveGenerationParams>): Record<string, unknown> {
  return {
    ...(gen.model !== undefined && { model: gen.model }),
    ...(gen.contextLength !== undefined && { contextLength: gen.contextLength }),
    ...(gen.temperature !== undefined && { temperature: gen.temperature }),
    ...(gen.timeout !== undefined && { timeout: gen.timeout }),
    ...(gen.customModels !== undefined && { customModels: gen.customModels }),
    ...(gen.effort !== undefined && { effort: gen.effort }),
  };
}

function assertModelPresent(role: Role, kind: RunnerKind, model: string | undefined): void {
  if (role === 'implementer' && kind !== 'cli' && !model) {
    throw configError.runnerMissingModel(role);
  }
}

function resolveWatchdogs(
  opts: BuildRunnerOpts,
  target: RunnerTarget,
): Pick<BuildRunnerOpts, 'idleWarnMs' | 'idleKillMs'> {
  const existing = existingAtTarget(opts, target);
  const idleWarnMs =
    opts.idleWarnMs ??
    (existing !== undefined && 'idleWarnMs' in existing ? existing.idleWarnMs : undefined);
  const idleKillMs =
    opts.idleKillMs ??
    (existing !== undefined && 'idleKillMs' in existing ? existing.idleKillMs : undefined);

  return { idleWarnMs, idleKillMs };
}

function spreadWatchdogs(watchdogs: ReturnType<typeof resolveWatchdogs>): Record<string, unknown> {
  return {
    ...(watchdogs.idleWarnMs !== undefined && { idleWarnMs: watchdogs.idleWarnMs }),
    ...(watchdogs.idleKillMs !== undefined && { idleKillMs: watchdogs.idleKillMs }),
  };
}

function existingPlannerCapabilities(
  existing: PlannerConfig | ImplementerConfig | undefined,
): PlannerCapabilities | undefined {
  return existing !== undefined &&
    (existing.kind === 'shell' || existing.kind === 'agent') &&
    'capabilities' in existing
    ? existing.capabilities
    : undefined;
}

export function inferKindFromTool(tool: string): RunnerKind {
  if (tool === 'shell') return 'shell';
  if (tool === 'agent') return 'agent';
  if (tool === 'agent-sdk') return 'agent-sdk';
  if (includes(CLI_TOOL_IDS, tool)) return 'cli';
  return 'api';
}

function inferKind(role: Role, opts: BuildRunnerOpts): RunnerKind {
  if (opts.kind) return opts.kind;
  if (opts.tool) return inferKindFromTool(opts.tool);
  if (opts.apiBase) return 'api';
  if (opts.command) return 'shell';
  if (opts.existing?.kind) return opts.existing.kind;
  throw configError.runnerKindIndeterminate(role, opts);
}

function parseRunnerConfig(
  role: Role,
  config: Record<string, unknown>,
): PlannerConfig | ImplementerConfig {
  return role === 'planner'
    ? PlannerConfigSchema.parse(config)
    : ImplementerConfigSchema.parse(config);
}

function getExistingApiBase(
  existing: PlannerConfig | ImplementerConfig | undefined,
  provider: string,
): string | undefined {
  return existing?.kind === 'api' && existing.provider === provider ? existing.apiBase : undefined;
}

function getApiDescriptor(provider: string) {
  return Object.values(API_PROVIDER_CATALOG).find((descriptor) => descriptor.id === provider);
}

function getDescriptorApiBase(provider: string): string | undefined {
  const descriptor = getApiDescriptor(provider);
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
  nextKind: 'api' | 'agent-sdk',
  provider?: string,
): string | undefined {
  if (!existing) return undefined;
  if (existing.kind === 'agent-sdk') {
    return nextKind === 'agent-sdk' || provider === 'anthropic' ? existing.apiKey : undefined;
  }
  if (existing.kind !== 'api') return undefined;
  if (nextKind === 'agent-sdk') {
    return existing.provider === 'anthropic' ? existing.apiKey : undefined;
  }
  return existing.provider === provider ? existing.apiKey : undefined;
}

function buildCliConfig(role: Role, opts: BuildRunnerOpts): PlannerConfig | ImplementerConfig {
  const tool = opts.tool ?? (opts.existing?.kind === 'cli' ? opts.existing.tool : undefined);
  if (!tool) throw configError.runnerMissingField(role, 'cli', 'tool');
  if (!includes(CLI_TOOL_IDS, tool)) {
    throw configError.unknownCliTool(tool, CLI_TOOL_IDS);
  }

  const target = { kind: 'cli' as const, id: tool };
  const existing = existingAtTarget(opts, target);
  const gen = resolveGenerationParams(opts, target);
  const modelPolicy = getCliModelPolicy(tool, role);
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
  const args = opts.args ?? (existing?.kind === 'cli' ? existing.args : undefined);
  const outputFormat =
    opts.outputFormat ?? (existing?.kind === 'cli' ? existing.outputFormat : undefined);
  const authChannel = destinationValue(
    targetState(opts, target),
    opts.authChannel,
    opts.existing?.kind === 'cli' ? opts.existing.authChannel : undefined,
  );
  const config: Record<string, unknown> = {
    kind: 'cli',
    tool,
    ...(authChannel !== undefined && { authChannel }),
    ...(args !== undefined && { args }),
    ...(outputFormat !== undefined && { outputFormat }),
    ...spreadWatchdogs(resolveWatchdogs(opts, target)),
    ...spreadGenParams(gen),
  };

  return parseRunnerConfig(role, config);
}

function buildApiConfig(role: Role, opts: BuildRunnerOpts): PlannerConfig | ImplementerConfig {
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
  const descriptor = getApiDescriptor(provider);
  const requestedApiBase = destinationValue(
    state,
    opts.apiBase,
    opts.existing?.kind === 'api' ? opts.existing.apiBase : undefined,
  );
  const existingApiBase = getExistingApiBase(opts.existing, provider);
  const resolvedApiBase = requestedApiBase ?? existingApiBase ?? getDescriptorApiBase(provider);

  if (!resolvedApiBase) {
    throw configError.unknownProvider(provider, KNOWN_API_PROVIDERS);
  }
  const apiBase = descriptor
    ? normalizeProviderEndpoint(descriptor.endpointPolicy, resolvedApiBase)
    : resolvedApiBase;

  const sourceApiKey =
    opts.existing !== undefined && 'apiKey' in opts.existing ? opts.existing.apiKey : undefined;
  const requestedApiKey = destinationValue(state, opts.apiKey, sourceApiKey);
  const existingApiKey =
    state === 'same' ? getExistingApiKey(opts.existing, 'api', provider) : undefined;
  const gen = resolveGenerationParams(opts, target);
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
  };

  return parseRunnerConfig(role, config);
}

function buildCommandConfig(
  role: Role,
  opts: BuildRunnerOpts,
  kind: 'shell' | 'agent',
): PlannerConfig | ImplementerConfig {
  const command =
    opts.command ?? (opts.existing?.kind === kind ? opts.existing.command : undefined);
  if (!command) throw configError.runnerMissingField(role, kind, 'command');

  const target = { kind, id: command };
  const existing = existingAtTarget(opts, target);
  const gen = resolveGenerationParams(opts, target);
  const args =
    opts.args ??
    (existing?.kind === 'shell' || existing?.kind === 'agent' ? existing.args : undefined);
  const outputFormat =
    opts.outputFormat ??
    (existing?.kind === 'shell' || existing?.kind === 'agent' ? existing.outputFormat : undefined);
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
    ...spreadWatchdogs(resolveWatchdogs(opts, target)),
    ...spreadGenParams(gen),
  };

  return parseRunnerConfig(role, config);
}

function buildAgentSdkConfig(role: Role, opts: BuildRunnerOpts): PlannerConfig | ImplementerConfig {
  const target = { kind: 'agent-sdk' as const };
  const state = targetState(opts, target);
  const sourceApiKey =
    opts.existing !== undefined && 'apiKey' in opts.existing ? opts.existing.apiKey : undefined;
  const requestedApiKey = destinationValue(state, opts.apiKey, sourceApiKey);
  const existingApiKey =
    state === 'same' ? getExistingApiKey(opts.existing, 'agent-sdk') : undefined;
  const gen = resolveGenerationParams(opts, target);
  assertModelPresent(role, 'agent-sdk', gen.model);
  const apiKey = requestedApiKey ?? existingApiKey;

  const config: Record<string, unknown> = {
    kind: 'agent-sdk',
    ...(apiKey !== undefined && { apiKey }),
    ...spreadWatchdogs(resolveWatchdogs(opts, target)),
    ...spreadGenParams(gen),
  };

  return parseRunnerConfig(role, config);
}
