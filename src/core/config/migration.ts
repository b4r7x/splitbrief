import { CLI_TOOL_IDS } from '../types/schemas/enums.js';
import { resolveDefaultApiBase } from '../providers/catalog.js';

/**
 * Migrate config from any version to current (v2).
 */
export function migrateConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be an object');
  }

  const obj = raw as Record<string, unknown>;
  const version = obj.version as number | undefined;

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
  if (!raw || typeof raw !== 'object') return undefined;

  const workflow = raw as Record<string, unknown>;
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
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${role} config must be an object`);
  }

  const runner = raw as Record<string, unknown>;
  const legacyKind = runner.kind as string | undefined;
  const tool = runner.tool as string | undefined;
  const command = runner.command as string | undefined;
  const apiBase = runner.apiBase as string | undefined;

  // Infer the new kind
  const kind = inferLegacyKind(legacyKind, tool, command, apiBase);

  switch (kind) {
    case 'cli':
      return {
        kind: 'cli',
        tool: tool || legacyKind, // legacy used kind as tool name
        ...pickCommonFields(runner),
        ...pickArgsOutputFormat(runner),
      };

    case 'api': {
      // provider comes from new 'provider' field, or legacy 'tool', or default
      const provider =
        (runner.provider as string) || tool || (role === 'implementer' ? 'ollama' : 'anthropic');

      const resolvedApiBase = apiBase || resolveDefaultApiBase(provider);
      if (!resolvedApiBase) {
        throw new Error(
          `${role}: Unknown provider '${provider}' requires explicit apiBase. ` +
            `Known providers: ollama, lm-studio, anthropic, openrouter, deepseek`
        );
      }

      const apiKeyValue = runner.apiKey as string | undefined;
      return {
        kind: 'api',
        provider,
        apiBase: resolvedApiBase,
        ...(apiKeyValue && { apiKey: apiKeyValue }),
        ...pickCommonFields(runner),
      };
    }

    case 'shell':
      if (!command) {
        throw new Error(`${role} shell kind requires 'command' field`);
      }
      return {
        kind: 'shell',
        command,
        ...pickCommonFields(runner),
        ...pickArgsOutputFormat(runner),
      };

    case 'agent':
      if (!command) {
        throw new Error(`${role} agent kind requires 'command' field`);
      }
      return {
        kind: 'agent',
        command,
        ...pickCommonFields(runner),
        ...pickArgsOutputFormat(runner),
      };

    case 'agent-sdk': {
      const sdkApiKey = runner.apiKey as string | undefined;
      return {
        kind: 'agent-sdk',
        ...(sdkApiKey && { apiKey: sdkApiKey }),
        ...pickCommonFields(runner),
      };
    }

    default:
      throw new Error(`${role}: Unknown kind '${kind}'`);
  }
}

function inferLegacyKind(
  legacyKind: string | undefined,
  tool: string | undefined,
  command: string | undefined,
  apiBase: string | undefined
): string {
  // New v2 kinds pass through
  if (legacyKind && ['cli', 'api', 'shell', 'agent', 'agent-sdk'].includes(legacyKind)) {
    return legacyKind;
  }

  // Legacy CLI-tool-as-kind (e.g., kind: 'claude-code')
  if (legacyKind && CLI_TOOL_IDS.includes(legacyKind as (typeof CLI_TOOL_IDS)[number])) {
    return 'cli';
  }

  // Infer from shape
  if (tool && CLI_TOOL_IDS.includes(tool as (typeof CLI_TOOL_IDS)[number])) return 'cli';
  if (apiBase) return 'api';
  if (command) return 'shell';

  // Default to api
  return 'api';
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
