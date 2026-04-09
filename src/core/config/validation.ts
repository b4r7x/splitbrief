import { ConfigSchema } from '../types/schemas/config.js';
import { KNOWN_PROVIDER_NAMES, PROVIDER_CATALOG, isProviderId } from '../providers/catalog.js';
import { narrowRecord } from '../../utils/type-guards.js';

export interface ConfigError {
  path: string;
  message: string;
}

function apiKeyErrors(data: Record<string, unknown>): ConfigError[] {
  const planner = narrowRecord(data['planner']);
  if (!planner) return [];

  const kind = planner['kind'];
  const errors: ConfigError[] = [];

  if (kind === 'agent-sdk') {
    const envVar = PROVIDER_CATALOG['agent-sdk'].apiKeyEnv!;
    const apiKey = planner['apiKey'] ?? process.env[envVar];
    if (!apiKey) {
      errors.push({ path: 'planner.apiKey', message: `Agent SDK requires planner.apiKey or ${envVar} env var` });
    }
  }

  if (kind === 'api') {
    const provider = typeof planner['provider'] === 'string' ? planner['provider'] : undefined;
    if (provider && isProviderId(provider)) {
      const info = PROVIDER_CATALOG[provider];
      if (info?.apiKeyEnv) {
        const apiKey = planner['apiKey'] ?? process.env[info.apiKeyEnv];
        if (!apiKey) {
          errors.push({ path: 'planner.apiKey', message: `${info.displayName} planner requires planner.apiKey or ${info.apiKeyEnv} env var` });
        }
      }
    }
  }

  return errors;
}

function implementerCrossFieldErrors(data: Record<string, unknown>): ConfigError[] {
  const implementer = narrowRecord(data['implementer']);
  if (!implementer) return [];

  const errors: ConfigError[] = [];
  const kind = implementer['kind'];

  if ((kind === 'shell' || kind === 'agent') && (!implementer['command'] || typeof implementer['command'] !== 'string')) {
    const label = kind === 'agent' ? 'Agent' : 'Shell';
    errors.push({ path: 'implementer.command', message: `${label} implementer requires implementer.command to be set` });
  }

  const tool = implementer['tool'];
  if (typeof tool === 'string' && !(KNOWN_PROVIDER_NAMES as readonly string[]).includes(tool)) {
    const apiBase = implementer['apiBase'];
    if (!apiBase || typeof apiBase !== 'string') {
      errors.push({ path: 'implementer.apiBase', message: `Unknown provider "${tool}" requires implementer.apiBase to be set` });
    }
  }

  return errors;
}

export function validateConfig(config: Record<string, unknown>): ConfigError[] {
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

  errors.push(...apiKeyErrors(config));
  errors.push(...implementerCrossFieldErrors(config));

  return errors;
}
