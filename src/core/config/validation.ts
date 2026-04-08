import type { OutputFormat } from '../types/index.js';
import { IMPLEMENTER_KINDS } from '../types/index.js';
import { KNOWN_PROVIDER_NAMES, PROVIDER_IDS } from '../providers/catalog.js';
import { getConfigValue } from './access.js';
const VALID_OUTPUT_FORMATS: readonly OutputFormat[] = ['stream-json', 'jsonl', 'text', 'opencode'] as const;

export interface ConfigError {
  path: string;
  message: string;
}

type ValidatorFn = (config: Record<string, unknown>) => ConfigError[];

function enumValidator(path: string, values: readonly string[]): ValidatorFn {
  return (config) => {
    const val = getConfigValue(config, path);
    if (val !== undefined && (typeof val !== 'string' || !values.includes(val))) {
      return [{ path, message: `Must be one of: ${values.join(', ')} (got ${JSON.stringify(val)})` }];
    }
    return [];
  };
}

function nonEmptyStringValidator(path: string): ValidatorFn {
  return (config) => {
    const val = getConfigValue(config, path);
    if (val !== undefined && (typeof val !== 'string' || val.length === 0)) {
      return [{ path, message: 'Must be a non-empty string' }];
    }
    return [];
  };
}

function booleanValidator(path: string): ValidatorFn {
  return (config) => {
    const val = getConfigValue(config, path);
    if (val !== undefined && typeof val !== 'boolean') {
      return [{ path, message: 'Must be true or false' }];
    }
    return [];
  };
}

function apiKeyValidator(
  toolValue: string | string[],
  envVar: string,
  label: string | ((config: Record<string, unknown>) => string),
): ValidatorFn {
  const tools = Array.isArray(toolValue) ? toolValue : [toolValue];
  return (config) => {
    const tool = getConfigValue(config, 'planner.tool');
    if (!tools.includes(tool as string)) return [];
    const apiKey = getConfigValue(config, 'planner.apiKey') ?? process.env[envVar];
    if (!apiKey) {
      const resolvedLabel = typeof label === 'function' ? label(config) : label;
      return [{ path: 'planner.apiKey', message: `${resolvedLabel} requires planner.apiKey or ${envVar} env var` }];
    }
    return [];
  };
}

const validators: ValidatorFn[] = [
  enumValidator('planner.tool', PROVIDER_IDS),

  apiKeyValidator(['agent-sdk', 'anthropic'], 'ANTHROPIC_API_KEY', (config) => {
    const tool = getConfigValue(config, 'planner.tool');
    return tool === 'agent-sdk' ? 'Agent SDK' : 'Anthropic planner';
  }),
  apiKeyValidator('openrouter', 'OPENROUTER_API_KEY', 'OpenRouter planner'),
  apiKeyValidator('deepseek', 'DEEPSEEK_API_KEY', 'DeepSeek planner'),

  (config) => {
    const tool = getConfigValue(config, 'planner.tool');
    if (tool !== 'shell') return [];
    const errors: ConfigError[] = [];
    const command = getConfigValue(config, 'planner.command');
    if (!command || typeof command !== 'string') {
      errors.push({ path: 'planner.command', message: 'Shell planner requires planner.command to be set' });
    }
    const outputFormat = getConfigValue(config, 'planner.outputFormat');
    if (outputFormat !== undefined && (typeof outputFormat !== 'string' || !(VALID_OUTPUT_FORMATS as readonly string[]).includes(outputFormat))) {
      errors.push({ path: 'planner.outputFormat', message: `Must be one of: ${VALID_OUTPUT_FORMATS.join(', ')} (got ${JSON.stringify(outputFormat)})` });
    }
    return errors;
  },

  enumValidator('implementer.kind', IMPLEMENTER_KINDS),

  (config) => {
    const implementerKind = getConfigValue(config, 'implementer.kind');
    if (implementerKind !== 'shell' && implementerKind !== 'agent') return [];
    const implementerCommand = getConfigValue(config, 'implementer.command');
    if (!implementerCommand || typeof implementerCommand !== 'string') {
      const label = implementerKind === 'agent' ? 'Agent' : 'Shell';
      return [{ path: 'implementer.command', message: `${label} implementer requires implementer.command to be set` }];
    }
    return [];
  },

  (config) => {
    const timeout = getConfigValue(config, 'implementer.timeout');
    if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0 || timeout > 600000)) {
      return [{ path: 'implementer.timeout', message: 'Must be a positive number <= 600000 (10 minutes)' }];
    }
    return [];
  },

  enumValidator('implementer.outputFormat', VALID_OUTPUT_FORMATS),

  (config) => {
    const tool = getConfigValue(config, 'implementer.tool');
    if (tool !== undefined && typeof tool !== 'string') {
      return [{ path: 'implementer.tool', message: 'Must be a string' }];
    }
    if (tool !== undefined && typeof tool === 'string' && !KNOWN_PROVIDER_NAMES.includes(tool)) {
      const apiBase = getConfigValue(config, 'implementer.apiBase');
      if (!apiBase || typeof apiBase !== 'string') {
        return [{ path: 'implementer.apiBase', message: `Unknown provider "${tool}" requires implementer.apiBase to be set` }];
      }
    }
    return [];
  },

  nonEmptyStringValidator('implementer.model'),

  (config) => {
    const ctx = getConfigValue(config, 'implementer.contextLength');
    if (ctx !== undefined && (typeof ctx !== 'number' || !Number.isInteger(ctx) || ctx <= 0)) {
      return [{ path: 'implementer.contextLength', message: 'Must be a positive integer' }];
    }
    return [];
  },

  (config) => {
    const temp = getConfigValue(config, 'implementer.temperature');
    if (temp !== undefined && (typeof temp !== 'number' || temp < 0 || temp > 2)) {
      return [{ path: 'implementer.temperature', message: 'Must be a number between 0 and 2' }];
    }
    return [];
  },

  ...['validation.typecheck', 'validation.lint', 'validation.test',
    'workflow.autoApproveSpec', 'workflow.autoApprovePlan'].map(booleanValidator),

  nonEmptyStringValidator('validation.testCommand'),

  enumValidator('workflow.mode', ['quick', 'standard', 'full']),
  enumValidator('workflow.commitStrategy', ['none', 'checkpoint', 'per-task']),

  (config) => {
    const retries = getConfigValue(config, 'workflow.maxRetries');
    if (retries !== undefined && (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0)) {
      return [{ path: 'workflow.maxRetries', message: 'Must be a non-negative integer' }];
    }
    return [];
  },

  enumValidator('theme', ['terminal', 'mono']),
  nonEmptyStringValidator('shikiTheme'),
  enumValidator('sessions.scope', ['project', 'global']),
];

export function validateConfig(config: Record<string, unknown>): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const validate of validators) {
    errors.push(...validate(config));
  }
  return errors;
}
