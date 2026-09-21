import { z } from 'zod';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { endpointPolicyFetch } from '../../core/providers/endpoint-policy.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import { composeAbortSignal, throwIfAborted } from '../../utils/abort.js';
import { DISCOVERY_HTTP_TIMEOUT_MS } from '../constants.js';
import { stripV1Suffix } from './constants.js';
import { createMetadataProvider } from './client/metadata.js';
import type {
  ProviderDefWithMetadata,
  ProviderModelListOptions,
  ProviderOverrides,
} from './types.js';
import type { EndpointPolicyFetch } from '../../lib/http/policy-fetch.js';

const DEFAULT_BASE = getKnownProviderBaseURL('llama-cpp');

/**
 * `GET /v1/models` is the whole inventory contract: a single-model server
 * answers with its own API id or alias, a router answers with one entry per
 * routed model. `meta` is optional — a router entry carries none — and its
 * absence stays absent rather than becoming a fabricated capacity.
 */
const LlamaCppModelSchema = z.looseObject({
  id: z.string().min(1),
  meta: z
    .looseObject({
      n_ctx_train: z.number().int().positive().optional(),
    })
    .optional(),
});

type LlamaCppModel = z.infer<typeof LlamaCppModelSchema>;

/**
 * Diagnostics the shared catalog classifier matches by exact text. `/health` is
 * unauthenticated on llama-server, so its answer is never evidence about a
 * rejected or malformed catalog and must not be appended to one.
 */
const EXACT_CATALOG_DIAGNOSTICS = new Set(['HTTP 401', 'HTTP 403', 'Invalid response payload']);

/** Read-only: `/health` reports what the server already is, and loads nothing. */
type ServerHealth = 'ok' | 'loading model' | 'unknown';

const HEALTH_LOADING_STATUS = 503;

function trainedContextTokens(model: LlamaCppModel): number | undefined {
  return model.meta?.n_ctx_train;
}

function llamaCppModelToDetected(model: LlamaCppModel, observedAt: number): DetectedModel {
  const maximumContextTokens = trainedContextTokens(model);
  return {
    id: model.id,
    providerId: 'llama-cpp',
    ...(maximumContextTokens === undefined ? {} : { maximumContextTokens }),
    ...(maximumContextTokens === undefined ? {} : { contextLength: maximumContextTokens }),
    // The catalog says which models the server serves, never which one it has
    // loaded; llama-server publishes no per-model load state.
    runtime: { loadState: 'unknown', observedAt },
  };
}

async function observeServerHealth(
  input: Readonly<{
    baseURL: string;
    policyFetch: EndpointPolicyFetch;
    signal: AbortSignal | undefined;
  }>,
): Promise<ServerHealth> {
  throwIfAborted(input.signal);
  const signal = composeAbortSignal(input.signal, DISCOVERY_HTTP_TIMEOUT_MS);
  try {
    const response = await input.policyFetch(`${stripV1Suffix(input.baseURL)}/health`, {
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(input.signal);
    await response.body?.cancel();
    if (response.ok) return 'ok';
    return response.status === HEALTH_LOADING_STATUS ? 'loading model' : 'unknown';
  } catch {
    throwIfAborted(input.signal);
    return 'unknown';
  }
}

export function createLlamaCppProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  const provider = createMetadataProvider<LlamaCppModel>(
    {
      name: 'llama-cpp',
      defaultBaseURL: DEFAULT_BASE,
      envKeyName: '',
      isLocal: true,
      schema: LlamaCppModelSchema,
      fallback: (id) => ({ id }),
      toDetected: (model) => llamaCppModelToDetected(model, Date.now()),
      contextLength: (model) => trainedContextTokens(model) ?? null,
      authentication: 'optional',
      rejectRedirects: true,
    },
    overrides,
  );
  let lastError: string | undefined;

  async function listInventory(
    options?: ProviderModelListOptions,
  ): Promise<readonly DetectedModel[]> {
    const models = await provider.listModelsWithMetadata(options);
    const diagnostic = provider.getLastError?.();
    if (diagnostic === undefined || EXACT_CATALOG_DIAGNOSTICS.has(diagnostic)) {
      lastError = diagnostic;
      return models;
    }
    const health = await observeServerHealth({
      baseURL: provider.baseURL,
      policyFetch: provider[endpointPolicyFetch],
      signal: options?.signal,
    });
    lastError = health === 'unknown' ? diagnostic : `${diagnostic} (/health: ${health})`;
    return models;
  }

  return {
    ...provider,
    getLastError: () => lastError,
    async listModels(options?: ProviderModelListOptions): Promise<string[]> {
      const models = await listInventory(options);
      return models.map((model) => model.id);
    },
    async listModelsWithMetadata(options?: ProviderModelListOptions): Promise<DetectedModel[]> {
      return [...(await listInventory(options))];
    },
  };
}
