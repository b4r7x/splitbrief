import { ModelsDevCatalogSchema, type ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { endpointPolicyError } from '../../core/providers/endpoint-policy.js';
import {
  createEndpointPolicyFetch,
  type EndpointPolicyFetch,
} from '../../lib/http/policy-fetch.js';
import { throwIfAborted } from '../../utils/abort.js';
import { error } from '../../utils/error.js';
import {
  cacheFailure,
  cancelResponseBody,
  failureFromCause,
  readBoundedResponseText,
  responseEtag,
} from './models-dev-cache/fetch.js';
import {
  MODELS_DEV_CATALOG_MAX_PAYLOAD_BYTES,
  cacheIdentity,
  catalogState,
  cloneSnapshot,
  persistSnapshot,
  readCachedSnapshot,
  rememberSnapshot,
} from './models-dev-cache/store.js';

export const MODELS_DEV_CATALOG_CACHE_TTL_MS = 60 * 60 * 1_000;
export const MODELS_DEV_CATALOG_TIMEOUT_MS = 10_000;

export const MODELS_DEV_CACHE_FAILURE_KINDS = [
  'cache-write-failed',
  'http-error',
  'invalid-json',
  'invalid-schema',
  'not-modified-without-cache',
  'payload-too-large',
  'request-failed',
  'timeout',
] as const;
export type ModelsDevCacheFailureKind = (typeof MODELS_DEV_CACHE_FAILURE_KINDS)[number];

export interface ModelsDevCacheFailure {
  readonly kind: ModelsDevCacheFailureKind;
  readonly message: string;
}

export interface ModelsDevCatalogSnapshot {
  readonly sourceUrl: string;
  readonly parserVersion: string;
  readonly catalog: ModelsDevCatalog;
  readonly catalogState: 'empty' | 'populated';
  readonly etag?: string | undefined;
  readonly fetchedAt: number;
  readonly validatedAt: number;
}

export type ModelsDevCatalogCacheOutcome =
  | Readonly<{
      kind: 'cached' | 'fresh' | 'not-modified';
      snapshot: ModelsDevCatalogSnapshot;
    }>
  | Readonly<{
      kind: 'stale';
      snapshot: ModelsDevCatalogSnapshot;
      failure: ModelsDevCacheFailure;
    }>
  | Readonly<{
      kind: 'failed';
      failure: ModelsDevCacheFailure;
    }>;

export interface ModelsDevCatalogCacheOptions {
  readonly cacheDir?: string | undefined;
  readonly fetch?: EndpointPolicyFetch | undefined;
  readonly maxPayloadBytes?: number | undefined;
  readonly mode?: 'automatic' | 'manual' | undefined;
  readonly now?: (() => number) | undefined;
  readonly parserVersion?: string | undefined;
  readonly sourceUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function modelsDevCatalogFailureError(failure: ModelsDevCacheFailure): Error {
  return error(`models-dev-cache-${failure.kind}`, failure.message, failure);
}

function withinCacheTtl(snapshot: ModelsDevCatalogSnapshot, now: number): boolean {
  return (
    now >= snapshot.validatedAt && now - snapshot.validatedAt < MODELS_DEV_CATALOG_CACHE_TTL_MS
  );
}

function staleOrFailed(
  snapshot: ModelsDevCatalogSnapshot | null,
  failure: ModelsDevCacheFailure,
): ModelsDevCatalogCacheOutcome {
  if (snapshot === null) return { kind: 'failed', failure };
  return { kind: 'stale', snapshot: cloneSnapshot(snapshot), failure };
}

export async function loadModelsDevCatalogCache(
  options: ModelsDevCatalogCacheOptions = {},
): Promise<ModelsDevCatalogSnapshot | null> {
  return readCachedSnapshot(cacheIdentity(options));
}

export async function refreshModelsDevCatalogCache(
  options: ModelsDevCatalogCacheOptions = {},
): Promise<ModelsDevCatalogCacheOutcome> {
  throwIfAborted(options.signal);
  const identity = cacheIdentity(options);
  const now = options.now ?? Date.now;
  const requestedAt = now();
  const cached = await readCachedSnapshot(identity);
  throwIfAborted(options.signal);
  const mode = options.mode ?? 'automatic';

  if (cached !== null && mode === 'automatic' && withinCacheTtl(cached, requestedAt)) {
    return { kind: 'cached', snapshot: cached };
  }

  const timeoutMs = options.timeoutMs ?? MODELS_DEV_CATALOG_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  const maxPayloadBytes = options.maxPayloadBytes ?? MODELS_DEV_CATALOG_MAX_PAYLOAD_BYTES;
  const headers = cached?.etag === undefined ? undefined : { 'If-None-Match': cached.etag };
  const policyFetch = createEndpointPolicyFetch(
    identity.sourceUrl,
    endpointPolicyError.invalid,
    options.fetch,
  );

  let response: Response;
  try {
    response = await policyFetch(identity.sourceUrl, {
      credentials: 'omit',
      signal,
      ...(headers === undefined ? {} : { headers }),
    });
  } catch (cause) {
    throwIfAborted(options.signal);
    return staleOrFailed(cached, failureFromCause(cause));
  }
  throwIfAborted(options.signal);

  if (response.status === 304) {
    await cancelResponseBody(response);
    if (cached === null) {
      return {
        kind: 'failed',
        failure: cacheFailure(
          'not-modified-without-cache',
          'Models.dev returned 304 without a cached catalog.',
        ),
      };
    }

    const etag = responseEtag(response);
    const snapshot: ModelsDevCatalogSnapshot = {
      ...cached,
      ...(etag === undefined ? {} : { etag }),
      validatedAt: requestedAt,
    };
    try {
      await persistSnapshot(identity, snapshot);
    } catch {
      return staleOrFailed(
        cached,
        cacheFailure('cache-write-failed', 'Models.dev catalog cache could not be updated.'),
      );
    }
    rememberSnapshot(identity.cacheKey, snapshot);
    return { kind: 'not-modified', snapshot: cloneSnapshot(snapshot) };
  }

  if (response.status !== 200) {
    await cancelResponseBody(response);
    return staleOrFailed(
      cached,
      cacheFailure('http-error', `Models.dev catalog request returned HTTP ${response.status}.`),
    );
  }

  let raw: string;
  try {
    const received = await readBoundedResponseText({ response, maxPayloadBytes, signal });
    if (received === null) {
      return staleOrFailed(
        cached,
        cacheFailure('payload-too-large', 'Models.dev catalog response exceeded its size limit.'),
      );
    }
    raw = received;
  } catch (cause) {
    throwIfAborted(options.signal);
    return staleOrFailed(cached, failureFromCause(cause));
  }
  throwIfAborted(options.signal);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return staleOrFailed(
      cached,
      cacheFailure('invalid-json', 'Models.dev catalog response was not valid JSON.'),
    );
  }

  const parsed = ModelsDevCatalogSchema.safeParse(json);
  if (!parsed.success) {
    return staleOrFailed(
      cached,
      cacheFailure(
        'invalid-schema',
        'Models.dev catalog response did not match the expected schema.',
      ),
    );
  }

  const etag = responseEtag(response);
  const snapshot: ModelsDevCatalogSnapshot = {
    sourceUrl: identity.sourceUrl,
    parserVersion: identity.parserVersion,
    catalog: parsed.data,
    catalogState: catalogState(parsed.data),
    ...(etag === undefined ? {} : { etag }),
    fetchedAt: requestedAt,
    validatedAt: requestedAt,
  };
  try {
    await persistSnapshot(identity, snapshot);
  } catch {
    return staleOrFailed(
      cached,
      cacheFailure('cache-write-failed', 'Models.dev catalog cache could not be updated.'),
    );
  }
  rememberSnapshot(identity.cacheKey, snapshot);
  return { kind: 'fresh', snapshot: cloneSnapshot(snapshot) };
}
