import OpenAI from 'openai';
import { validateApiBaseUrl } from '../../../core/providers/validate-api-base.js';
import type { ProviderDef } from '../types.js';
import { providerError } from '../errors.js';

export function validateProviderBaseURL(baseURL: string): string {
  try {
    return validateApiBaseUrl(baseURL);
  } catch (err) {
    const reason =
      err instanceof Error ? err.message.replace(/^Invalid apiBase [^:]+: /, '') : String(err);
    throw providerError.invalidApiBase(baseURL, reason);
  }
}

export function createClientFromProvider(provider: ProviderDef): OpenAI {
  return new OpenAI({ baseURL: provider.baseURL, apiKey: provider.apiKey() });
}
