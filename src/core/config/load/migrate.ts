import { CLI_TOOL_IDS, RUNNER_KINDS } from '../../schemas/enums.js';
import { getRunnerKindMeta } from '../../schemas/runner-fields.js';
import { resolveDefaultApiBase } from '../../providers/catalog.js';
import { narrowRecord, includes } from '../../../utils/type-guards.js';
import type { RunnerKind } from '../../schemas/enums.js';

export function migrateConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be an object');
  }

  const obj = narrowRecord(raw);
  if (!obj) throw new Error('Config must be an object');
  const version = typeof obj.version === 'number' ? obj.version : undefined;

  if (version === 2) {
    return raw;
  }

  if (version !== undefined && version !== 1 && version !== 2) {
    throw new Error(`Unsupported config version: ${version}. Expected 1 or 2.`);
  }

  // v1 or missing version → migrate to v2
  return migrateV1ToV2(obj);
}

function migrateV1ToV2(obj: Record<string, unknown>): unknown {
  return {
    version: 2,
    planner: obj.planner ? migrateRunnerV1ToV2('planner', obj.planner) : undefined,
    implementer: obj.implementer ? migrateRunnerV1ToV2('implementer', obj.implementer) : undefined,
    validation: obj.validation,
    workflow: migrateWorkflowV1ToV2(obj.workflow),
    theme: obj.theme,
    shikiTheme: obj.shikiTheme,
    sessions: obj.sessions,
    escalation: obj.escalation,
  };
}

function migrateWorkflowV1ToV2(raw: unknown): unknown {
  const workflow = narrowRecord(raw);
  if (!workflow) return undefined;

  const result = { ...workflow };

  // Migrate commitPerTask → commitStrategy
  if ('commitPerTask' in result) {
    const commitPerTask = result.commitPerTask;
    delete result.commitPerTask;
    if (result.commitStrategy === undefined) {
      result.commitStrategy = commitPerTask ? 'per-task' : 'none';
    }
  }

  return result;
}

function migrateRunnerV1ToV2(role: 'planner' | 'implementer', raw: unknown): unknown {
  const runner = narrowRecord(raw);
  if (!runner) {
    throw new Error(`${role} config must be an object`);
  }

  const legacyKind = typeof runner.kind === 'string' ? runner.kind : undefined;
  const tool = typeof runner.tool === 'string' ? runner.tool : undefined;
  const command = typeof runner.command === 'string' ? runner.command : undefined;
  const apiBase = typeof runner.apiBase === 'string' ? runner.apiBase : undefined;

  // Infer the new kind
  const kind = inferLegacyKind(legacyKind, tool, command, apiBase, role);

  // cli and api have unique migration logic
  if (kind === 'cli') {
    // Planners with no explicit tool/kind default to claude-code
    const resolvedTool = tool || legacyKind || (role === 'planner' ? 'claude-code' : undefined);
    return {
      kind: 'cli',
      tool: resolvedTool,
      ...pickCommonFields(runner),
      ...pickArgsOutputFormat(runner),
    };
  }

  if (kind === 'api') {
    const providerField = typeof runner.provider === 'string' ? runner.provider : undefined;
    const provider = providerField || tool || (role === 'implementer' ? 'ollama' : 'anthropic');

    const resolvedApiBase = apiBase || resolveDefaultApiBase(provider);
    if (!resolvedApiBase) {
      throw new Error(
        `${role}: Unknown provider '${provider}' requires explicit apiBase. ` +
          `Known providers: ollama, lm-studio, anthropic, openrouter, deepseek`
      );
    }

    const apiKeyValue = typeof runner.apiKey === 'string' ? runner.apiKey : undefined;
    return {
      kind: 'api',
      provider,
      apiBase: resolvedApiBase,
      ...(apiKeyValue && { apiKey: apiKeyValue }),
      ...pickCommonFields(runner),
    };
  }

  // All other kinds are descriptor-driven
  const meta = getRunnerKindMeta(kind);

  if (meta.requiresCommand && !command) {
    throw new Error(`${role} ${kind} kind requires 'command' field`);
  }

  const result: Record<string, unknown> = { kind };
  if (meta.requiresCommand) result.command = command;
  if (meta.usesApiKey) {
    const apiKeyValue = typeof runner.apiKey === 'string' ? runner.apiKey : undefined;
    if (apiKeyValue) result.apiKey = apiKeyValue;
  }
  Object.assign(result, pickCommonFields(runner));
  if (meta.usesArgsOutputFormat) Object.assign(result, pickArgsOutputFormat(runner));
  return result;
}

function inferLegacyKind(
  legacyKind: string | undefined,
  tool: string | undefined,
  command: string | undefined,
  apiBase: string | undefined,
  role: 'planner' | 'implementer',
): RunnerKind {
  // New v2 kinds pass through
  if (legacyKind && includes(RUNNER_KINDS, legacyKind)) {
    return legacyKind;
  }

  // Legacy CLI-tool-as-kind (e.g., kind: 'claude-code')
  if (legacyKind && includes(CLI_TOOL_IDS, legacyKind)) {
    return 'cli';
  }

  // Infer from shape
  if (tool && includes(CLI_TOOL_IDS, tool)) return 'cli';
  if (apiBase) return 'api';
  if (command) return 'shell';

  // Default: planners fall back to cli (claude-code); implementers fall back to api (ollama)
  return role === 'planner' ? 'cli' : 'api';
}

function pickCommonFields(runner: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (runner.model) result.model = runner.model;
  if (runner.customModels) result.customModels = runner.customModels;
  if (runner.contextLength) result.contextLength = runner.contextLength;
  if (runner.temperature !== undefined) result.temperature = runner.temperature;
  if (runner.timeout) result.timeout = runner.timeout;
  return result;
}

function pickArgsOutputFormat(runner: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (runner.args) result.args = runner.args;
  if (runner.outputFormat) result.outputFormat = runner.outputFormat;
  return result;
}
