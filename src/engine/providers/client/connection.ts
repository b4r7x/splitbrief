import OpenAI from 'openai';
import { validateApiBaseUrl } from '../../../core/providers/validate-api-base.js';
import type { ProviderDef } from '../types.js';
import { providerError } from '../errors.js';
import {
  endpointPolicyError,
  endpointPolicyFetch,
  type EndpointPolicyFetchOwner,
} from '../../../core/providers/endpoint-policy.js';

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
  const fetch = hasEndpointPolicyFetch(provider) ? provider[endpointPolicyFetch] : undefined;
  if (fetch === undefined) {
    // OpenAI's default fetch follows redirects itself. A provider without the
    // policy-owned transport must never reach that path with credentials.
    throw endpointPolicyError.unsupported();
  }

  return new OpenAI({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey(),
    fetch,
  });
}

function hasEndpointPolicyFetch(
  provider: ProviderDef,
): provider is ProviderDef & EndpointPolicyFetchOwner {
  return endpointPolicyFetch in provider;
}
