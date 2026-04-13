import { CLI_TOOL_IDS, RUNNER_KINDS } from '../types/schemas/enums.js';
import { includes } from '../../utils/type-guards.js';
import { resolveDefaultApiBase } from '../providers.js';
import { PlannerConfigSchema } from '../types/schemas/planner-config.js';
import { ImplementerConfigSchema } from '../types/schemas/implementer-config.js';
import type { PlannerConfig } from '../types/schemas/planner-config.js';
import type { ImplementerConfig } from '../types/schemas/implementer-config.js';
import type { RunnerKind } from '../types/schemas/enums.js';
import type { OutputFormat } from '../types/schemas/enums.js';

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
      throw new Error(`${role}: unknown runner kind '${kind}'. Expected one of: ${RUNNER_KINDS.join(', ')}.`);
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

function inferKind(role: Role, opts: BuildRunnerOpts): RunnerKind {
  if (opts.kind) return opts.kind;
  if (opts.tool && includes(CLI_TOOL_IDS, opts.tool))
    return 'cli';
  if (opts.apiBase) return 'api';
  if (opts.command) return 'shell';
  if (opts.existing?.kind) return opts.existing.kind;
  throw new Error(
    `Cannot infer runner kind for ${role}: need one of 'kind', 'tool', 'apiBase', 'command', or 'existing' to be provided. Got: ${JSON.stringify(opts)}`
  );
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

  return role === 'planner' ? PlannerConfigSchema.parse(config) : ImplementerConfigSchema.parse(config);
}

function buildApiConfig(
  role: Role,
  opts: BuildRunnerOpts
): PlannerConfig | ImplementerConfig {
  const provider = opts.tool || (role === 'implementer' ? 'ollama' : 'anthropic');
  const existingApiBase = opts.existing?.kind === 'api' ? opts.existing.apiBase : undefined;
  const apiBase = opts.apiBase || existingApiBase || resolveDefaultApiBase(provider);

  if (!apiBase) {
    throw new Error(
      `Unknown provider '${provider}' requires explicit apiBase. ` +
        `Known providers: ollama, lm-studio, anthropic, openrouter, deepseek`
    );
  }

  const existingApiKey = opts.existing?.kind === 'api' || opts.existing?.kind === 'agent-sdk' ? opts.existing.apiKey : undefined;
  const gen = resolveGenerationParams(opts);
  assertModelPresent(role, gen.model);

  const config: Record<string, unknown> = {
    kind: 'api',
    provider,
    apiBase,
    ...((opts.apiKey ?? existingApiKey) && { apiKey: opts.apiKey ?? existingApiKey }),
    ...spreadGenParams(gen),
  };

  return role === 'planner' ? PlannerConfigSchema.parse(config) : ImplementerConfigSchema.parse(config);
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

  return role === 'planner' ? PlannerConfigSchema.parse(config) : ImplementerConfigSchema.parse(config);
}

function buildAgentSdkConfig(
  role: Role,
  opts: BuildRunnerOpts
): PlannerConfig | ImplementerConfig {
  const existingApiKey = opts.existing?.kind === 'api' || opts.existing?.kind === 'agent-sdk' ? opts.existing.apiKey : undefined;
  const gen = resolveGenerationParams(opts);
  assertModelPresent(role, gen.model);

  const config: Record<string, unknown> = {
    kind: 'agent-sdk',
    ...((opts.apiKey ?? existingApiKey) && { apiKey: opts.apiKey ?? existingApiKey }),
    ...spreadGenParams(gen),
  };

  return role === 'planner' ? PlannerConfigSchema.parse(config) : ImplementerConfigSchema.parse(config);
}
