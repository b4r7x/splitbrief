import OpenAI from 'openai';
import type { ApiOffering } from '../../../core/providers/api-provider-catalog.js';
import { validateApiBaseUrl } from '../../../core/providers/validate-api-base.js';
import { error } from '../../../utils/error.js';
import type { ProviderDef } from '../types.js';
import { providerError } from '../errors.js';
import { resolveApiKeyOverride } from './api-key.js';
import {
  endpointPolicyError,
  endpointPolicyFetch,
  normalizeProviderEndpoint,
  type EndpointPolicy,
  type EndpointPolicyFetchOwner,
} from '../../../core/providers/endpoint-policy.js';
import {
  createEndpointPolicyFetch,
  type EndpointPolicyFetch,
} from '../../../lib/http/policy-fetch.js';

export interface ProviderConnectionMetadata {
  readonly baseURL: string;
  readonly offering: ApiOffering | undefined;
  readonly credentialPrefix: string | null;
}

export interface CreateProviderConnectionOpts {
  readonly requestedBaseURL: string;
  readonly endpointPolicy: EndpointPolicy;
  readonly offering?: ApiOffering | undefined;
  readonly credentialOverride?: string | undefined;
  readonly envKeyName?: string | undefined;
  readonly apiKeyDefault?: string | undefined;
  readonly credentialPrefix?: string | null | undefined;
  readonly fetchImplementation?: EndpointPolicyFetch;
}

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

function resolveConnectionCredential(
  opts: CreateProviderConnectionOpts,
  credentialPrefix: string | null,
): string {
  const value =
    resolveApiKeyOverride(opts.credentialOverride) ??
    (opts.envKeyName !== undefined ? process.env[opts.envKeyName] : undefined) ??
    opts.apiKeyDefault ??
    '';
  assertCredentialPrefix(value, credentialPrefix);
  return value;
}

export function createProviderConnection(
  opts: CreateProviderConnectionOpts,
): ProviderConnectionMetadata & EndpointPolicyFetchOwner & { readonly apiKey: () => string } {
  const baseURL = normalizeProviderEndpoint(opts.endpointPolicy, opts.requestedBaseURL);
  const credentialPrefix = opts.credentialPrefix ?? null;
  const resolvedCredential = resolveConnectionCredential(opts, credentialPrefix);
  const policyFetch = createEndpointPolicyFetch(
    baseURL,
    endpointPolicyError.invalid,
    opts.fetchImplementation,
  );

  return {
    baseURL,
    offering: opts.offering,
    credentialPrefix,
    apiKey: () => resolvedCredential,
    [endpointPolicyFetch]: policyFetch,
  };
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
  return typeof Reflect.get(provider, endpointPolicyFetch) === 'function';
}
