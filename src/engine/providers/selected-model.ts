import { cloneDetectedModel } from '../../core/discovery/clone-model.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import {
  getApiProviderDescriptor,
  type ApiProviderId,
} from '../../core/providers/api-provider-catalog.js';
import { resolveDefaultApiBase } from '../../core/providers/catalog.js';
import { normalizeProviderEndpoint } from '../../core/providers/endpoint-policy.js';
import { throwIfAborted } from '../../utils/abort.js';
import { detectProviderCatalog } from './catalog-detection.js';
import type { ProviderCatalogFailureKind, ProviderOverrides } from './types.js';

export type SelectedProviderModelFailureKind =
  | ProviderCatalogFailureKind
  | 'empty-catalog'
  | 'missing-model';

/**
 * Names the connection an observation is bound to, so a seat never reads
 * another seat's catalog for its own selection. Provider and endpoint only;
 * it carries no credential.
 */
export function apiConnectionContextKey(provider: string, apiBase: string | undefined): string {
  const policy = getApiProviderDescriptor(provider)?.endpointPolicy;
  const endpoint = apiBase ?? resolveDefaultApiBase(provider) ?? undefined;
  const normalized =
    policy !== undefined && endpoint !== undefined
      ? normalizeProviderEndpoint(policy, endpoint)
      : endpoint;
  return ['runner-availability-connection-v1', provider, normalized]
    .map((part) => encodeURIComponent(String(part)))
    .join('|');
}

export interface ProbeSelectedProviderModelOptions {
  readonly provider: ApiProviderId;
  /** The connection this selection was made on; never another seat's. */
  readonly overrides: ProviderOverrides | undefined;
  /** Identifies the connection the observation is bound to. */
  readonly contextKey: string;
  /** The exact catalog id that was selected, tag and quantization included. */
  readonly selectionId: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * A read-only observation of the selected model on its own connection. `found`
 * carries the catalog entry as the provider reported it — absent metadata stays
 * absent — and is not a permission receipt for generating with it: the caller
 * compares `contextKey` and `selectionId` against its own prepared snapshot
 * first.
 */
export type SelectedProviderModelProbe =
  | Readonly<{
      kind: 'found';
      contextKey: string;
      selectionId: string;
      model: DetectedModel;
      observedAt: number;
    }>
  | Readonly<{
      kind: 'failed';
      contextKey: string;
      selectionId: string;
      failure: SelectedProviderModelFailureKind;
      diagnostic: string;
    }>;

export async function probeSelectedProviderModel(
  options: ProbeSelectedProviderModelOptions,
): Promise<SelectedProviderModelProbe> {
  throwIfAborted(options.signal);
  const outcome = await detectProviderCatalog({
    provider: options.provider,
    configOverrides: options.overrides,
    signal: options.signal,
  });
  throwIfAborted(options.signal);

  const bound = { contextKey: options.contextKey, selectionId: options.selectionId };
  if (outcome.kind === 'failed') {
    return { kind: 'failed', ...bound, failure: outcome.failure, diagnostic: outcome.diagnostic };
  }
  if (outcome.catalog === 'empty') {
    return {
      kind: 'failed',
      ...bound,
      failure: 'empty-catalog',
      diagnostic: 'Provider catalog is empty.',
    };
  }
  const model = outcome.models.find((candidate) => candidate.id === options.selectionId);
  if (model === undefined) {
    return {
      kind: 'failed',
      ...bound,
      failure: 'missing-model',
      diagnostic: `Provider catalog has no model with id "${options.selectionId}".`,
    };
  }
  return { kind: 'found', ...bound, model: cloneDetectedModel(model), observedAt: Date.now() };
}
