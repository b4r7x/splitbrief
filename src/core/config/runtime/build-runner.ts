import { CLI_TOOL_IDS, KNOWN_API_PROVIDERS } from '../../schemas/enums.js';
import { includes, assertNever } from '../../../utils/type-guards.js';
import { resolveDefaultApiBase } from '../../providers/catalog.js';
import { PlannerConfigSchema } from '../../schemas/planner-config.js';
import { ImplementerConfigSchema } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { RunnerKind } from '../../schemas/enums.js';
import type { OutputFormat } from '../../schemas/enums.js';

export type Role = 'planner' | 'implementer';

export interface BuildRunnerOpts {
  kind?: RunnerKind | undefined;
  tool?: string | undefined; // cli: tool id; api: provider name
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
  existing?: PlannerConfig | ImplementerConfig | undefined;
}

export function buildRunnerConfig(role: 'planner', opts: BuildRunnerOpts): PlannerConfig;
export function buildRunnerConfig(role: 'implementer', opts: BuildRunnerOpts): ImplementerConfig;
export function buildRunnerConfig(
  role: Role,
  opts: BuildRunnerOpts
): PlannerConfig | ImplementerConfig {
  const kind = inferKind(role, opts);
  switch (kind) {
    case 'cli': return buildCliConfig(role, opts);
    case 'api': return buildApiConfig(role, opts);
    case 'shell': return buildCommandConfig(role, opts, 'shell');
    case 'agent': return buildCommandConfig(role, opts, 'agent');
    case 'agent-sdk': return buildAgentSdkConfig(role, opts);
    default: return assertNever(kind);
  }
}

interface GenerationParams {
  model?: string | undefined;
  contextLength?: number | undefined;
  temperature?: number | undefined;
  timeout?: number | undefined;
  customModels?: string[] | undefined;
}

function resolveGenerationParams(opts: BuildRunnerOpts): GenerationParams {
  const ex = opts.existing;
  return {
    model: opts.model ?? ex?.model,
    contextLength: opts.contextLength ?? ex?.contextLength,
    temperature: opts.temperature !== undefined ? opts.temperature : ex?.temperature,
    timeout: opts.timeout ?? ex?.timeout,
    customModels: opts.customModels ?? ex?.customModels,
  };
}

function spreadGenParams(gen: ReturnType<typeof resolveGenerationParams>): Record<string, unknown> {
  return {
    ...(gen.model && { model: gen.model }),
    ...(gen.contextLength && { contextLength: gen.contextLength }),
    ...(gen.temperature !== undefined && { temperature: gen.temperature }),
    ...(gen.timeout && { timeout: gen.timeout }),
    ...(gen.customModels && { customModels: gen.customModels }),
  };
}

function assertModelPresent(role: Role, model: string | undefined): void {
  if (role === 'implementer' && !model) {
    throw new Error(`${role}: 'model' is required but was not provided.`);
  }
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
  throw new Error(
    `Cannot infer runner kind for ${role}: need one of 'kind', 'tool', 'apiBase', 'command', or 'existing' to be provided. Got: ${JSON.stringify(opts)}`
  );
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
  return existing?.kind === 'api' && existing.provider === provider
    ? existing.apiBase
    : undefined;
}

function getExistingApiKey(
  existing: PlannerConfig | ImplementerConfig | undefined,
  nextKind: 'api' | 'agent-sdk',
  provider?: string,
): string | undefined {
  if (!existing) return undefined;
  if (existing.kind === 'agent-sdk') {
    return nextKind === 'agent-sdk' || provider === 'anthropic'
      ? existing.apiKey
      : undefined;
  }
  if (existing.kind !== 'api') return undefined;
  if (nextKind === 'agent-sdk') {
    return existing.provider === 'anthropic' ? existing.apiKey : undefined;
  }
  return existing.provider === provider ? existing.apiKey : undefined;
}

function buildCliConfig(
  role: Role,
  opts: BuildRunnerOpts
): PlannerConfig | ImplementerConfig {
  if (!opts.tool) throw new Error(`${role} cli kind requires 'tool' field`);
  if (!includes(CLI_TOOL_IDS, opts.tool)) {
    throw new Error(
      `Unknown CLI tool: ${opts.tool}. Valid tools: ${CLI_TOOL_IDS.join(', ')}`
    );
  }

  const gen = resolveGenerationParams(opts);
  assertModelPresent(role, gen.model);

  const config: Record<string, unknown> = {
    kind: 'cli',
    tool: opts.tool,
    ...(opts.args && { args: opts.args }),
    ...(opts.outputFormat && { outputFormat: opts.outputFormat }),
    ...spreadGenParams(gen),
  };

  return parseRunnerConfig(role, config);
}

function buildApiConfig(
  role: Role,
  opts: BuildRunnerOpts
): PlannerConfig | ImplementerConfig {
  const provider = opts.tool || (role === 'implementer' ? 'ollama' : 'anthropic');
  const existingApiBase = getExistingApiBase(opts.existing, provider);
  const apiBase = opts.apiBase || existingApiBase || resolveDefaultApiBase(provider);

  if (!apiBase) {
    throw new Error(
      `Unknown provider '${provider}' requires explicit apiBase. ` +
        `Known providers: ${KNOWN_API_PROVIDERS.join(', ')}`
    );
  }

  const existingApiKey = getExistingApiKey(opts.existing, 'api', provider);
  const gen = resolveGenerationParams(opts);
  assertModelPresent(role, gen.model);

  const config: Record<string, unknown> = {
    kind: 'api',
    provider,
    apiBase,
    ...((opts.apiKey ?? existingApiKey) && { apiKey: opts.apiKey ?? existingApiKey }),
    ...spreadGenParams(gen),
  };

  return parseRunnerConfig(role, config);
}

function buildCommandConfig(
  role: Role,
  opts: BuildRunnerOpts,
  kind: 'shell' | 'agent'
): PlannerConfig | ImplementerConfig {
  if (!opts.command) throw new Error(`${role} ${kind} kind requires 'command' field`);

  const gen = resolveGenerationParams(opts);
  assertModelPresent(role, gen.model);

  const config: Record<string, unknown> = {
    kind,
    command: opts.command,
    ...(opts.args && { args: opts.args }),
    ...(opts.outputFormat && { outputFormat: opts.outputFormat }),
    ...spreadGenParams(gen),
  };

  return parseRunnerConfig(role, config);
}

function buildAgentSdkConfig(
  role: Role,
  opts: BuildRunnerOpts
): PlannerConfig | ImplementerConfig {
  const existingApiKey = getExistingApiKey(opts.existing, 'agent-sdk');
  const gen = resolveGenerationParams(opts);
  assertModelPresent(role, gen.model);

  const config: Record<string, unknown> = {
    kind: 'agent-sdk',
    ...((opts.apiKey ?? existingApiKey) && { apiKey: opts.apiKey ?? existingApiKey }),
    ...spreadGenParams(gen),
  };

  return parseRunnerConfig(role, config);
}
