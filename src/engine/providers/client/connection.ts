import OpenAI from 'openai';
import { TIMEOUTS } from '../../../core/pipeline-spec/timeouts.js';
import { validateApiBaseUrl } from '../../../core/providers/validate-api-base.js';
import { error } from '../../../utils/error.js';
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

export function assertCredentialPrefix(credential: string, prefix: string | null): void {
  if (prefix === null || prefix.length === 0 || credential.startsWith(prefix)) return;
  throw error(
    'provider-credential-prefix-mismatch',
    // The stable kind travels in the message so a quoted diagnostic still maps
    // to the published `credential-family-mismatch` readiness state.
    'provider-credential-prefix-mismatch: credential value does not match the declared credential prefix',
    { prefix },
  );
}

export function createClientFromProvider(
  provider: ProviderDef,
  opts: { readonly timeoutMs?: number | undefined } = {},
): OpenAI {
  const fetch = hasEndpointPolicyFetch(provider) ? provider[endpointPolicyFetch] : undefined;
  if (fetch === undefined) {
    // OpenAI's default fetch follows redirects itself. A provider without the
    // policy-owned transport must never reach that path with credentials.
    throw endpointPolicyError.unsupported();
  }

  const apiKey = provider.apiKey();
  return new OpenAI({
    baseURL: provider.baseURL,
    // The SDK requires a nonempty key at construction. The local placeholder
    // never reaches HTTP and never changes the provider's authentication evidence.
    apiKey: apiKey || 'splitbrief-no-auth',
    defaultHeaders: apiKey.length === 0 ? { Authorization: null, 'api-key': null } : undefined,
    adminAPIKey: null,
    organization: null,
    project: null,
    fetch,
    // A hidden SDK retry would multiply the application's own total deadline,
    // and the SDK default timeout is unrelated to it. Both are stated here.
    maxRetries: 0,
    timeout: opts.timeoutMs ?? TIMEOUTS.implementerMs,
  });
}

function hasEndpointPolicyFetch(
  provider: ProviderDef,
): provider is ProviderDef & EndpointPolicyFetchOwner {
  return typeof Reflect.get(provider, endpointPolicyFetch) === 'function';
}
