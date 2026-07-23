import { providerError } from '../errors.js';

const API_KEY_ENV_PREFIX = 'env:';

export function apiKeyEnvReference(apiKey: string | undefined): string | undefined {
  if (!apiKey?.startsWith(API_KEY_ENV_PREFIX)) return undefined;
  const envVar = apiKey.slice(API_KEY_ENV_PREFIX.length).trim();
  if (!envVar) throw providerError.invalidApiKeyEnvReference();
  return envVar;
}

export function resolveApiKeyOverride(apiKey: string | undefined): string | undefined {
  const envVar = apiKeyEnvReference(apiKey);
  if (!envVar) return apiKey;
  const value = process.env[envVar];
  if (!value) throw providerError.apiKeyEnvMissing(envVar);
  return value;
}
