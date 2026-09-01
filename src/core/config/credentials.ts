import { PROVIDER_CATALOG, isSameOrigin } from '../providers/catalog.js';
import { isProviderId } from '../schemas/enums.js';
import type { ImplementerConfig } from '../schemas/implementer-config.js';
import type { PlannerConfig } from '../schemas/planner-config.js';
import { redactSecrets } from '../../utils/redact.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';

export const API_KEY_ENV_PREFIX = 'env:';

export type RunnerCredentialConfig = PlannerConfig | ImplementerConfig;

export function parseApiKeyEnvRef(apiKey: string | undefined): string | undefined {
  if (!apiKey?.startsWith(API_KEY_ENV_PREFIX)) return undefined;
  const envVar = apiKey.slice(API_KEY_ENV_PREFIX.length).trim();
  return envVar.length > 0 ? envVar : undefined;
}

export function isInlineApiKey(apiKey: string | undefined): boolean {
  if (!apiKey) return false;
  return parseApiKeyEnvRef(apiKey) === undefined;
}

export function missingEnvRefError(
  path: string,
  envVar: string,
): { path: string; message: string } {
  return {
    path: `${path}.apiKey`,
    message: `Environment variable ${envVar} is not set (referenced by ${path}.apiKey).`,
  };
}

export function customEndpointCredentialSourceError(opts: {
  role: ActiveRunnerRole;
  path: string;
  config: RunnerCredentialConfig;
}): { path: string; message: string } | undefined {
  const { role, path, config } = opts;
  if (config.kind !== 'api') return undefined;
  if (!isProviderId(config.provider)) return undefined;

  const info = PROVIDER_CATALOG[config.provider];
  if (!info.apiKeyEnv || !info.baseURL || !config.apiBase) return undefined;
  if (isSameOrigin(config.apiBase, info.baseURL)) return undefined;
  if (config.apiKey && isInlineApiKey(config.apiKey)) return undefined;

  const envVar = (config.apiKey ? parseApiKeyEnvRef(config.apiKey) : undefined) ?? info.apiKeyEnv;
  const envKey = process.env[envVar];
  if (!envKey) return undefined;

  return {
    path: `${path}.apiKey`,
    message: `${info.displayName} ${role} with custom endpoint ${redactSecrets(config.apiBase)} cannot use ${envVar} without an inline apiKey (API key exfiltration risk).`,
  };
}

export function customProviderEnvApiKeyReferenceError(opts: {
  role: ActiveRunnerRole;
  path: string;
  config: RunnerCredentialConfig;
}): { path: string; message: string } | undefined {
  const { role, path, config } = opts;
  if (config.kind !== 'api') return undefined;
  if (isProviderId(config.provider)) return undefined;

  const envVar = parseApiKeyEnvRef(config.apiKey);
  if (!envVar) return undefined;

  return {
    path: `${path}.apiKey`,
    message:
      `Custom/unknown provider ${config.provider} ${role} cannot use env apiKey reference env:${envVar} ` +
      `with apiBase ${redactSecrets(config.apiBase)} (API key exfiltration risk). Use an inline apiKey for this custom provider.`,
  };
}
