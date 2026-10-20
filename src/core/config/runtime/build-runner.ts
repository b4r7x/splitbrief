import { includes, assertNever } from '../../../utils/type-guards.js';
import { resolveDefaultApiBase } from '../../providers/catalog.js';
import {
  getApiProviderDescriptor,
  KNOWN_API_PROVIDER_IDS,
} from '../../providers/api-provider-catalog.js';
import { normalizeProviderEndpoint } from '../../providers/endpoint-policy.js';
import {
  CLI_TOOL_IDS,
  cliModelPolicyViolations,
  getCliModelPolicy,
  type CliAuthChannelId,
} from '../../runners/cli-tool-catalog.js';
import {
  runnerRoleForActiveRole,
  type ActiveRunnerRole,
  type PlannerTierRole,
} from '../../runners/seat-roles.js';
import { PlannerConfigSchema } from '../../schemas/planner-config.js';
import { ImplementerConfigSchema } from '../../schemas/implementer-config.js';
import { ReviewerConfigSchema } from '../../schemas/reviewer-config.js';
import { configError } from '../errors.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { ApiOffering } from '../../providers/api-provider-catalog.js';
import type { EffortLevel, RunnerKind } from '../../schemas/enums.js';
import type { OutputFormat } from '../../schemas/enums.js';

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
  variant?: string | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  capabilities?: PlannerCapabilities | undefined;
  service?: string | undefined;
  offering?: ApiOffering | undefined;
  existing?: PlannerConfig | ImplementerConfig | undefined;
}

type PlannerCapabilities = Extract<PlannerConfig, { kind: 'shell' }>['capabilities'];

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

interface GenerationParams {
  model?: string | undefined;
  contextLength?: number | undefined;
  temperature?: number | undefined;
  timeout?: number | undefined;
  customModels?: string[] | undefined;
  effort?: EffortLevel | undefined;
  variant?: string | undefined;
}

export interface RunnerTarget {
  kind: RunnerKind;
  id?: string | undefined;
}

export interface CarriedSeatSettings {
  timeout?: number;
  contextLength?: number;
  temperature?: number;
  customModels?: string[];
  idleWarnMs?: number;
  idleKillMs?: number;
  args?: string[];
  outputFormat?: OutputFormat;
  authChannel?: CliAuthChannelId;
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

/**
 * The settings a rebuilt seat keeps from the runner it replaces: `timeout` on every
 * rebuild, the tool's own settings only while the target stays the same. The caller
 * chooses the model, effort, variant and fallback.
 */
export function carriedSeatSettings(
  existing: PlannerConfig | ImplementerConfig | undefined,
  target: RunnerTarget,
): CarriedSeatSettings {
  const same = existingAtTarget({ existing }, target);
  const subprocess = same?.kind === 'api' ? undefined : same;
  return {
    ...(existing?.timeout !== undefined && { timeout: existing.timeout }),
    ...(same?.contextLength !== undefined && { contextLength: same.contextLength }),
    ...(same?.temperature !== undefined && { temperature: same.temperature }),
    ...(same?.customModels !== undefined && { customModels: same.customModels }),
    ...(subprocess?.idleWarnMs !== undefined && { idleWarnMs: subprocess.idleWarnMs }),
    ...(subprocess?.idleKillMs !== undefined && { idleKillMs: subprocess.idleKillMs }),
    ...(subprocess?.args !== undefined && { args: subprocess.args }),
    ...(subprocess?.outputFormat !== undefined && { outputFormat: subprocess.outputFormat }),
    ...(same?.kind === 'cli' &&
      same.authChannel !== undefined && { authChannel: same.authChannel }),
  };
}

function resolveGenerationParams(
  opts: BuildRunnerOpts,
  target: RunnerTarget,
  carried: CarriedSeatSettings,
): GenerationParams {
  const sameTarget = existingAtTarget(opts, target);
  const state = targetState(opts, target);

  return {
    model: opts.model ?? sameTarget?.model,
    contextLength: opts.contextLength ?? carried.contextLength,
    temperature: opts.temperature ?? carried.temperature,
    timeout: opts.timeout ?? carried.timeout,
    customModels: opts.customModels ?? carried.customModels,
    effort: state === 'changed' ? undefined : (opts.effort ?? sameTarget?.effort),
    variant: state === 'changed' ? undefined : (opts.variant ?? sameTarget?.variant),
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
    ...(gen.variant !== undefined && { variant: gen.variant }),
  };
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

function resolveWatchdogs(
  opts: BuildRunnerOpts,
  carried: CarriedSeatSettings,
): Pick<BuildRunnerOpts, 'idleWarnMs' | 'idleKillMs'> {
  return {
    idleWarnMs: opts.idleWarnMs ?? carried.idleWarnMs,
    idleKillMs: opts.idleKillMs ?? carried.idleKillMs,
  };
}

function spreadWatchdogs(watchdogs: ReturnType<typeof resolveWatchdogs>): Record<string, unknown> {
  return {
    ...(watchdogs.idleWarnMs !== undefined && { idleWarnMs: watchdogs.idleWarnMs }),
    ...(watchdogs.idleKillMs !== undefined && { idleKillMs: watchdogs.idleKillMs }),
  };
}

/** The seat's declared fallback is its own choice, not the target's: every rebuild keeps it. */
function spreadFallback(
  existing: PlannerConfig | ImplementerConfig | undefined,
): Record<string, unknown> {
  return existing?.fallback === undefined ? {} : { fallback: existing.fallback };
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
    throw configError.unknownCliTool(tool, CLI_TOOL_IDS);
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
  const authChannel = opts.authChannel ?? carried.authChannel;
  const config: Record<string, unknown> = {
    kind: 'cli',
    tool,
    ...(authChannel !== undefined && { authChannel }),
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
    throw configError.unknownProvider(provider, KNOWN_API_PROVIDER_IDS);
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
