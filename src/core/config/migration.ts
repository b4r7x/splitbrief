import type { PlannerConfig, CliPlannerTool, OutputFormat } from '../types/index.js';
import { isCliTool, OUTPUT_FORMATS } from '../types/index.js';
import { PROVIDER_IDS, type ProviderId } from '../providers/catalog.js';
import { includes } from '../../utils/type-guards.js';

function optString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' ? v : undefined;
}

function optStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
  const v = raw[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

function optOutputFormat(raw: Record<string, unknown>): OutputFormat | undefined {
  const v = optString(raw, 'outputFormat');
  return v && includes(OUTPUT_FORMATS, v) ? v : undefined;
}

export function migratePlannerConfig(raw: Record<string, unknown>): PlannerConfig {
  const rawKind = typeof raw['kind'] === 'string' ? raw['kind'] : undefined;
  if (rawKind) return normalizeDuShape(raw, rawKind);

  const tool = typeof raw['tool'] === 'string' ? raw['tool'] : 'claude-code';
  const provider = typeof raw['provider'] === 'string' ? raw['provider'] : undefined;

  if (tool === 'claude-code' && provider) {
    if (!includes(PROVIDER_IDS, provider)) throw new Error(`Unknown planner provider: ${provider}`);
    return buildApi(raw, provider);
  }

  if (isCliTool(tool)) {
    return buildCli(raw, tool);
  }

  if (tool === 'agent-sdk') return buildAgentSdk(raw);
  if (tool === 'shell') return buildShell(raw);

  // Remaining tools are API providers (anthropic/openrouter/ollama/lm-studio/deepseek).
  if (includes(PROVIDER_IDS, tool)) {
    return buildApi(raw, tool);
  }

  throw new Error(`Unknown planner tool: ${tool}`);
}

function normalizeDuShape(raw: Record<string, unknown>, kind: string): PlannerConfig {
  switch (kind) {
    case 'cli': {
      const tool = typeof raw['tool'] === 'string' ? raw['tool'] : 'claude-code';
      if (!isCliTool(tool)) throw new Error(`Unknown CLI planner tool: ${tool}`);
      return buildCli(raw, tool);
    }
    case 'agent-sdk':
      return buildAgentSdk(raw);
    case 'api': {
      const provider = typeof raw['provider'] === 'string' ? raw['provider'] : 'anthropic';
      if (!includes(PROVIDER_IDS, provider)) throw new Error(`Unknown API planner provider: ${provider}`);
      return buildApi(raw, provider);
    }
    case 'shell':
      return buildShell(raw);
    default:
      throw new Error(`Unknown planner kind: ${kind}`);
  }
}

function buildCli(raw: Record<string, unknown>, tool: CliPlannerTool): PlannerConfig {
  const result: PlannerConfig & { kind: 'cli' } = { kind: 'cli', tool };
  const model = optString(raw, 'model');
  if (model) result.model = model;
  const args = optStringArray(raw, 'args');
  if (args) result.args = args;
  const outputFormat = optOutputFormat(raw);
  if (outputFormat) result.outputFormat = outputFormat;
  const customModels = optStringArray(raw, 'customModels');
  if (customModels) result.customModels = customModels;
  return result;
}

function buildAgentSdk(raw: Record<string, unknown>): PlannerConfig {
  const result: PlannerConfig & { kind: 'agent-sdk' } = { kind: 'agent-sdk' };
  const model = optString(raw, 'model');
  if (model) result.model = model;
  const permissionMode = optString(raw, 'permissionMode');
  if (permissionMode === 'acceptEdits') result.permissionMode = 'acceptEdits';
  const apiKey = optString(raw, 'apiKey');
  if (apiKey) result.apiKey = apiKey;
  const customModels = optStringArray(raw, 'customModels');
  if (customModels) result.customModels = customModels;
  return result;
}

function buildApi(raw: Record<string, unknown>, provider: ProviderId): PlannerConfig {
  const model = optString(raw, 'model') ?? 'default';
  const result: PlannerConfig & { kind: 'api' } = { kind: 'api', provider, model };
  const apiKey = optString(raw, 'apiKey');
  if (apiKey) result.apiKey = apiKey;
  const apiBase = optString(raw, 'apiBase');
  if (apiBase) result.apiBase = apiBase;
  const customModels = optStringArray(raw, 'customModels');
  if (customModels) result.customModels = customModels;
  return result;
}

function buildShell(raw: Record<string, unknown>): PlannerConfig {
  const command = optString(raw, 'command');
  if (!command) throw new Error('Shell planner requires planner.command');
  const result: PlannerConfig & { kind: 'shell' } = { kind: 'shell', command };
  const model = optString(raw, 'model');
  if (model) result.model = model;
  const args = optStringArray(raw, 'args');
  if (args) result.args = args;
  const outputFormat = optOutputFormat(raw);
  if (outputFormat) result.outputFormat = outputFormat;
  const customModels = optStringArray(raw, 'customModels');
  if (customModels) result.customModels = customModels;
  return result;
}
