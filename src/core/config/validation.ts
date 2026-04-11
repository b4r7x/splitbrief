import { ConfigSchema } from '../types/schemas/config.js';
import { PROVIDER_CATALOG, isProviderId } from '../providers/catalog.js';
import type { Config, PlannerConfig, ImplementerConfig } from '../types/index.js';
import { getRunnerDisplayName, getRunnerApiKey } from './runner-config.js';

export interface ConfigError {
  path: string;
  message: string;
}

export interface ConfigValidation {
  errors: ConfigError[];
  warnings: string[];
  data?: Config | undefined;
}

const KEY_FORMAT_HINTS: Record<string, { pattern: RegExp; example: string }> = {
  anthropic: { pattern: /^sk-ant-/, example: 'sk-ant-...' },
  'agent-sdk': { pattern: /^sk-ant-/, example: 'sk-ant-...' },
  openrouter: { pattern: /^sk-or-/, example: 'sk-or-...' },
  deepseek: { pattern: /^sk-/, example: 'sk-...' },
};

function apiKeyErrors(config: Config): ConfigError[] {
  const { planner } = config;
  const errors: ConfigError[] = [];

  if (planner.kind === 'agent-sdk') {
    const envVar = PROVIDER_CATALOG['agent-sdk']?.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    if (!planner.apiKey && !process.env[envVar]) {
      errors.push({ path: 'planner.apiKey', message: `Agent SDK requires planner.apiKey or ${envVar} env var` });
    }
  }

  if (planner.kind === 'api' && isProviderId(planner.provider)) {
    const info = PROVIDER_CATALOG[planner.provider];
    if (info.apiKeyEnv) {
      if (!planner.apiKey && !process.env[info.apiKeyEnv]) {
        errors.push({ path: 'planner.apiKey', message: `${info.displayName} planner requires planner.apiKey or ${info.apiKeyEnv} env var` });
      }
    }
  }

  return errors;
}

function keyFormatWarnings(provider: string, key: string): string[] {
  const hint = KEY_FORMAT_HINTS[provider];
  if (!hint || hint.pattern.test(key)) return [];
  return [`API key for ${provider} doesn't match expected format (${hint.example}). Verify your key is correct.`];
}

interface KeyInfo {
  key: string | undefined;
  provider: string | undefined;
  envVar: string | undefined;
  inConfig: boolean;
}

function plannerKeyInfo(planner: PlannerConfig): KeyInfo {
  switch (planner.kind) {
    case 'agent-sdk': {
      const envVar = PROVIDER_CATALOG['agent-sdk']?.apiKeyEnv;
      const envKey = envVar ? process.env[envVar] : undefined;
      return { key: planner.apiKey ?? envKey, provider: 'agent-sdk', envVar, inConfig: !!planner.apiKey };
    }
    case 'api': {
      const envVar = isProviderId(planner.provider) ? PROVIDER_CATALOG[planner.provider].apiKeyEnv : undefined;
      const envKey = envVar ? process.env[envVar] : undefined;
      return { key: planner.apiKey ?? envKey, provider: planner.provider, envVar, inConfig: !!planner.apiKey };
    }
    default:
      return { key: undefined, provider: undefined, envVar: undefined, inConfig: false };
  }
}

function implementerKeyInfo(implementer: ImplementerConfig): KeyInfo {
  const provider = getRunnerDisplayName(implementer);
  const providerId = isProviderId(provider) ? provider : undefined;
  const envVar = providerId ? PROVIDER_CATALOG[providerId].apiKeyEnv : undefined;
  const envKey = envVar ? process.env[envVar] : undefined;
  const apiKey = getRunnerApiKey(implementer);
  return { key: apiKey ?? envKey, provider: providerId, envVar, inConfig: !!apiKey };
}

export function securityWarnings(config: Config): string[] {
  const warnings: string[] = [];

  for (const [role, info] of [['planner', plannerKeyInfo(config.planner)], ['implementer', implementerKeyInfo(config.implementer)]] as const) {
    if (info.inConfig && info.envVar) {
      warnings.push(`API key found in ${role} config. For better security, set ${info.envVar} environment variable and remove apiKey from config.`);
    }
    if (info.key && info.provider) {
      warnings.push(...keyFormatWarnings(info.provider, info.key));
    }
  }

  return warnings;
}

export function validateConfig(config: Record<string, unknown>): ConfigValidation {
  const result = ConfigSchema.safeParse(config);

  const errors: ConfigError[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
  }

  if (result.success) {
    errors.push(...apiKeyErrors(result.data));
  }

  const warnings = result.success ? securityWarnings(result.data) : [];

  return { errors, warnings, data: result.success ? result.data : undefined };
}
