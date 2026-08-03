import type { z } from 'zod';
import type {
  ProviderDefWithMetadata,
  ProviderModelListOptions,
  ProviderOverrides,
} from '../types.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import { warnError } from '../../../lib/warn.js';
import { error as createError } from '../../../utils/error.js';
import { createProviderShell } from './shell.js';
import { resolveApiKeyOverride } from './api-key.js';
import { assertCredentialPrefix, validateProviderBaseURL } from './connection.js';
import {
  extractOpenAIModelList,
  fetchModelList,
  isOpenAIModelList,
  sanitizeProviderDiagnostic,
} from './request.js';
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
import { getApiProviderDescriptor } from '../../../core/providers/api-provider-catalog.js';
import { throwIfAborted } from '../../../utils/abort.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type MetadataProviderAuthentication = 'none' | 'optional' | 'required';
export type MetadataProviderCredentialSource = 'ambient-and-override' | 'override-only';

export interface MetadataProviderOpts<TRaw extends { id: string }> {
  name: string;
  defaultBaseURL: string;
  envKeyName: string;
  apiKeyDefault?: string;
  isLocal: boolean;
  schema: z.ZodType<TRaw>;
  fallback: (id: string) => TRaw;
  toDetected?: (raw: TRaw) => DetectedModel;
  contextLength?: (raw: TRaw) => number | null;
  modelsUrl?: (baseURL: string) => string;
  headers?: (apiKey: string) => Record<string, string>;
  extractModels?: (data: unknown) => TRaw[] | null;
  /**
   * Local providers are unauthenticated by default, but an explicitly secured
   * loopback server can opt in without weakening the no-credential default.
   */
  authentication?: MetadataProviderAuthentication;
  /**
   * A local offering can reserve an ambient credential for a separate remote
   * offering while still accepting an explicit local config override.
   */
  credentialSource?: MetadataProviderCredentialSource;
  /** First-party loopback inventories do not follow redirects. */
  rejectRedirects?: boolean;
  /**
   * Candidate modules may supply their own endpoint policy before they resolve
   * any credential. Known providers use the catalog policy by default.
   */
  endpointPolicy?: EndpointPolicy;
}

function createRedirectRejectingFetch(): EndpointPolicyFetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    throw endpointPolicyError.invalid();
  };
}

function catalogEndpointPolicy(name: string): EndpointPolicy | undefined {
  return getApiProviderDescriptor(name)?.endpointPolicy;
}

function resolveEndpointPolicy(
  opts: Pick<MetadataProviderOpts<{ id: string }>, 'name' | 'endpointPolicy'>,
  requestedBaseURL: string,
): EndpointPolicy | undefined {
  const catalogPolicy = catalogEndpointPolicy(opts.name);
  if (catalogPolicy !== undefined) return catalogPolicy;
  if (opts.endpointPolicy !== undefined) return opts.endpointPolicy;

  // An unknown provider has no catalog identity to borrow. Validate its
  // explicit URL before credential resolution and retain the origin lock, but
  // preserve custom-provider support for an explicitly configured HTTP
  // endpoint. Candidate modules should provide their declared policy.
  validateProviderBaseURL(requestedBaseURL);
  return undefined;
}

export function createMetadataProvider<TRaw extends { id: string }>(
  opts: MetadataProviderOpts<TRaw>,
  overrides?: ProviderOverrides,
): ProviderDefWithMetadata & EndpointPolicyFetchOwner {
  const requestedBaseURL = overrides?.apiBase ?? opts.defaultBaseURL;
  const endpointPolicy = resolveEndpointPolicy(opts, requestedBaseURL);
  const baseURL =
    endpointPolicy === undefined
      ? validateProviderBaseURL(requestedBaseURL)
      : normalizeProviderEndpoint(endpointPolicy, requestedBaseURL);
  const policyFetch = opts.rejectRedirects
    ? createEndpointPolicyFetch(
        baseURL,
        endpointPolicyError.invalid,
        createRedirectRejectingFetch(),
      )
    : createEndpointPolicyFetch(baseURL, endpointPolicyError.invalid);

  // Endpoint validation intentionally precedes this call. An invalid endpoint
  // must fail closed before an env: reference can read a credential.
  const resolvedApiKey = resolveApiKeyOverride(overrides?.apiKey);
  const shell = createProviderShell({ name: opts.name, baseURL, isLocal: opts.isLocal });
  const credentialPrefix = getApiProviderDescriptor(opts.name)?.credentialPrefix ?? null;
  // A credential from the wrong provider family must fail here, before it can
  // reach a request. An absent credential is a separate, already-handled state.
  const credentialSource = opts.credentialSource ?? 'ambient-and-override';
  const resolveConfiguredCredential = (): string | undefined =>
    resolvedApiKey ??
    (credentialSource === 'ambient-and-override' ? process.env[opts.envKeyName] : undefined);
  const resolveCredential = (): string => resolveConfiguredCredential() ?? opts.apiKeyDefault ?? '';
  const apiKey = (): string => {
    const value = resolveCredential();
    if (value.length > 0) assertCredentialPrefix(value, credentialPrefix);
    return value;
  };
  const authentication = opts.authentication ?? (opts.isLocal ? 'none' : 'required');

  function getUrl(): string {
    return opts.modelsUrl ? opts.modelsUrl(baseURL) : `${baseURL}/models`;
  }

  function defaultExtractModels(data: unknown): TRaw[] | null {
    if (!isOpenAIModelList(data)) return null;
    return extractOpenAIModelList(data, (m) => {
      const parsed = opts.schema.safeParse(m);
      return parsed.success ? parsed.data : opts.fallback(m.id);
    });
  }

  const extractModels = opts.extractModels ?? defaultExtractModels;

  async function fetchModels(options?: ProviderModelListOptions): Promise<TRaw[]> {
    throwIfAborted(options?.signal);
    const key = apiKey();
    const configuredCredential = resolveConfiguredCredential();
    const requestCredential = authentication === 'none' ? '' : (configuredCredential ?? '');
    if (authentication === 'required' && !requestCredential) return [];
    let headers: Record<string, string> | undefined;
    try {
      headers = opts.headers ? opts.headers(requestCredential) : undefined;
    } catch (error) {
      const diagnostic = sanitizeProviderDiagnostic(error, {
        credentialValues: key ? [key] : undefined,
      });
      shell.trackError(diagnostic);
      throw createError('provider-header-callback-failed', diagnostic, {
        provider: opts.name,
        diagnostic,
      });
    }
    return fetchModelList({
      endpoint: getUrl(),
      fetch: policyFetch,
      ...(headers
        ? { headers }
        : { apiKey: requestCredential.length > 0 ? requestCredential : undefined }),
      onError: (message) =>
        shell.trackError(
          message === undefined
            ? undefined
            : sanitizeProviderDiagnostic(message, {
                credentialValues: key ? [key] : undefined,
                headers,
              }),
        ),
      signal: options?.signal,
      extractModels,
    });
  }

  const toDetected = opts.toDetected ?? ((m: TRaw) => ({ id: m.id }));
  const getContextLength = opts.contextLength ?? (() => null);

  return {
    [endpointPolicyFetch]: policyFetch,
    name: opts.name,
    baseURL,
    apiKey,
    isLocal: opts.isLocal,
    getLastError: shell.getLastError,

    async listModels(options?: ProviderModelListOptions): Promise<string[]> {
      const models = await fetchModels(options);
      return models.map((m) => m.id);
    },

    async listModelsWithMetadata(options?: ProviderModelListOptions): Promise<DetectedModel[]> {
      const models = await fetchModels(options);
      return models.map(toDetected);
    },

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const models = await fetchModels();
        const entry = models.find((m) => m.id === model);
        return entry ? getContextLength(entry) : null;
      } catch (error) {
        warnError(
          `detectContextLength(${opts.name})`,
          sanitizeProviderDiagnostic(error, {
            credentialValues: authentication === 'none' ? undefined : [resolveCredential()],
          }),
        );
        return null;
      }
    },
  };
}
