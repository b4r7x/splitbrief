import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { ModelsDevCatalogSchema, type ModelsDevCatalog } from '../../core/schemas/models-dev.js';
import { endpointPolicyError } from '../../core/providers/endpoint-policy.js';
import { writeSecureFileAsync } from '../../lib/fs.js';
import {
  createEndpointPolicyFetch,
  type EndpointPolicyFetch,
} from '../../lib/http/policy-fetch.js';
import { throwIfAborted } from '../../utils/abort.js';
import { error } from '../../utils/error.js';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';
export const MODELS_DEV_CATALOG_PARSER_VERSION = 'models-dev-api-json-v1';
export const MODELS_DEV_CATALOG_CACHE_TTL_MS = 60 * 60 * 1_000;
export const MODELS_DEV_CATALOG_TIMEOUT_MS = 10_000;
export const MODELS_DEV_CATALOG_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const MODELS_DEV_CACHE_VERSION = 1;
const MODELS_DEV_CACHE_DIRECTORY = 'cache';
const MODELS_DEV_CACHE_FILE_PREFIX = 'models-dev-catalog';
const MODELS_DEV_CACHE_MAX_ENTRIES = 4;
const MODELS_DEV_CACHE_FILE_NAME_PATTERN = new RegExp(
  `^${MODELS_DEV_CACHE_FILE_PREFIX}-[a-f0-9]{64}\\.json$`,
);
const MODELS_DEV_CACHE_METADATA_BYTES = 64 * 1024;
const MODELS_DEV_CACHE_MAX_FILE_BYTES =
  MODELS_DEV_CATALOG_MAX_PAYLOAD_BYTES + MODELS_DEV_CACHE_METADATA_BYTES;
const MODELS_DEV_ETAG_MAX_LENGTH = 4_096;
const MODELS_DEV_SOURCE_URL_MAX_LENGTH = 2_048;

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

const ModelsDevCacheRecordSchema = z
  .object({
    version: z.literal(MODELS_DEV_CACHE_VERSION),
    sourceUrl: z.string().min(1).max(MODELS_DEV_SOURCE_URL_MAX_LENGTH),
    parserVersion: z.string().min(1).max(256),
    catalog: ModelsDevCatalogSchema,
    etag: z.string().min(1).max(MODELS_DEV_ETAG_MAX_LENGTH).optional(),
    fetchedAt: z.number().finite().nonnegative(),
    validatedAt: z.number().finite().nonnegative(),
  })
  .strict();
type ModelsDevCacheRecord = z.infer<typeof ModelsDevCacheRecordSchema>;

interface ModelsDevCacheIdentity {
  readonly cacheKey: string;
  readonly cachePath: string;
  readonly parserVersion: string;
  readonly sourceUrl: string;
}

interface ModelsDevCacheFileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface BoundedModelsDevCacheFile extends ModelsDevCacheFileIdentity {
  readonly raw: string;
}

interface ModelsDevCacheDiskEntry extends ModelsDevCacheFileIdentity {
  readonly cachePath: string;
  readonly fileName: string;
  readonly validatedAt: number;
}

const snapshots = new Map<string, ModelsDevCatalogSnapshot>();

function modelsDevCacheError(failure: ModelsDevCacheFailure): Error {
  return error(`models-dev-cache-${failure.kind}`, failure.message, failure);
}

export function modelsDevCatalogFailureError(failure: ModelsDevCacheFailure): Error {
  return modelsDevCacheError(failure);
}

function cacheFailure(kind: ModelsDevCacheFailureKind, message: string): ModelsDevCacheFailure {
  return { kind, message };
}

function normalizeSourceUrl(sourceUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw error('models-dev-cache-invalid-source', 'Models.dev source URL is invalid.');
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.href.length > MODELS_DEV_SOURCE_URL_MAX_LENGTH
  ) {
    throw error('models-dev-cache-invalid-source', 'Models.dev source URL is invalid.');
  }

  return parsed.href;
}

function cacheFileName(cacheKey: string): string {
  const digest = createHash('sha256').update(cacheKey).digest('hex');
  return `${MODELS_DEV_CACHE_FILE_PREFIX}-${digest}.json`;
}

export function resolveModelsDevUserCacheDir(): string {
  return join(homedir(), SPLITBRIEF_DIR, MODELS_DEV_CACHE_DIRECTORY);
}

function cacheIdentity(options: ModelsDevCatalogCacheOptions): ModelsDevCacheIdentity {
  const sourceUrl = normalizeSourceUrl(options.sourceUrl ?? MODELS_DEV_CATALOG_URL);
  const parserVersion = options.parserVersion ?? MODELS_DEV_CATALOG_PARSER_VERSION;
  const cacheDir = options.cacheDir ?? resolveModelsDevUserCacheDir();
  const sourceKey = [sourceUrl, parserVersion].join('|');
  const cachePath = join(cacheDir, cacheFileName(sourceKey));
  return {
    cacheKey: cachePath,
    cachePath,
    parserVersion,
    sourceUrl,
  };
}

export function resolveModelsDevCatalogCachePath(
  options: ModelsDevCatalogCacheOptions = {},
): string {
  return cacheIdentity(options).cachePath;
}

function catalogState(catalog: ModelsDevCatalog): ModelsDevCatalogSnapshot['catalogState'] {
  return Object.keys(catalog).length === 0 ? 'empty' : 'populated';
}

function cloneSnapshot(snapshot: ModelsDevCatalogSnapshot): ModelsDevCatalogSnapshot {
  return {
    sourceUrl: snapshot.sourceUrl,
    parserVersion: snapshot.parserVersion,
    catalog: structuredClone(snapshot.catalog),
    catalogState: snapshot.catalogState,
    ...(snapshot.etag === undefined ? {} : { etag: snapshot.etag }),
    fetchedAt: snapshot.fetchedAt,
    validatedAt: snapshot.validatedAt,
  };
}

function snapshotFromRecord(record: ModelsDevCacheRecord): ModelsDevCatalogSnapshot {
  return {
    sourceUrl: record.sourceUrl,
    parserVersion: record.parserVersion,
    catalog: record.catalog,
    catalogState: catalogState(record.catalog),
    ...(record.etag === undefined ? {} : { etag: record.etag }),
    fetchedAt: record.fetchedAt,
    validatedAt: record.validatedAt,
  };
}

function recordFromSnapshot(snapshot: ModelsDevCatalogSnapshot): ModelsDevCacheRecord {
  return {
    version: MODELS_DEV_CACHE_VERSION,
    sourceUrl: snapshot.sourceUrl,
    parserVersion: snapshot.parserVersion,
    catalog: snapshot.catalog,
    ...(snapshot.etag === undefined ? {} : { etag: snapshot.etag }),
    fetchedAt: snapshot.fetchedAt,
    validatedAt: snapshot.validatedAt,
  };
}

function rememberSnapshot(cacheKey: string, snapshot: ModelsDevCatalogSnapshot): void {
  snapshots.delete(cacheKey);
  snapshots.set(cacheKey, cloneSnapshot(snapshot));
  while (snapshots.size > MODELS_DEV_CACHE_MAX_ENTRIES) {
    const oldestKey = snapshots.keys().next().value;
    if (oldestKey === undefined) return;
    snapshots.delete(oldestKey);
  }
}

function matchesCacheFileIdentity(stats: Stats, identity: ModelsDevCacheFileIdentity): boolean {
  return stats.isFile() && stats.dev === identity.device && stats.ino === identity.inode;
}

async function readBoundedCacheFile(path: string): Promise<BoundedModelsDevCacheFile | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const beforeOpen = await lstat(path);
    if (!beforeOpen.isFile()) return null;

    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (
      !matchesCacheFileIdentity(stats, { device: beforeOpen.dev, inode: beforeOpen.ino }) ||
      !Number.isSafeInteger(stats.size) ||
      stats.size < 0 ||
      stats.size > MODELS_DEV_CACHE_MAX_FILE_BYTES
    ) {
      return null;
    }

    const afterOpen = await lstat(path);
    if (!matchesCacheFileIdentity(afterOpen, { device: stats.dev, inode: stats.ino })) {
      return null;
    }

    const buffer = Buffer.alloc(stats.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) return null;
    return {
      raw: buffer.subarray(0, bytesRead).toString('utf8'),
      device: stats.dev,
      inode: stats.ino,
    };
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

function parseModelsDevCacheRecord(raw: string): ModelsDevCacheRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = ModelsDevCacheRecordSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function isCacheRecordAtExpectedPath(record: ModelsDevCacheRecord, fileName: string): boolean {
  try {
    return (
      normalizeSourceUrl(record.sourceUrl) === record.sourceUrl &&
      cacheFileName([record.sourceUrl, record.parserVersion].join('|')) === fileName
    );
  } catch {
    return false;
  }
}

async function validatedDiskEntries(cacheDir: string): Promise<ModelsDevCacheDiskEntry[]> {
  const entries = await readdir(cacheDir, { withFileTypes: true });
  const validEntries: ModelsDevCacheDiskEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !MODELS_DEV_CACHE_FILE_NAME_PATTERN.test(entry.name)) continue;

    const cachePath = join(cacheDir, entry.name);
    const file = await readBoundedCacheFile(cachePath);
    if (file === null) continue;

    const record = parseModelsDevCacheRecord(file.raw);
    if (record === null || !isCacheRecordAtExpectedPath(record, entry.name)) continue;

    validEntries.push({
      cachePath,
      fileName: entry.name,
      validatedAt: record.validatedAt,
      device: file.device,
      inode: file.inode,
    });
  }

  return validEntries;
}

function compareOldestCacheEntries(
  left: ModelsDevCacheDiskEntry,
  right: ModelsDevCacheDiskEntry,
): number {
  if (left.validatedAt < right.validatedAt) return -1;
  if (left.validatedAt > right.validatedAt) return 1;
  if (left.fileName < right.fileName) return -1;
  if (left.fileName > right.fileName) return 1;
  return 0;
}

async function removeValidatedCacheEntry(entry: ModelsDevCacheDiskEntry): Promise<void> {
  const stats = await lstat(entry.cachePath);
  if (!matchesCacheFileIdentity(stats, entry)) return;
  await unlink(entry.cachePath);
  snapshots.delete(entry.cachePath);
}

async function evictOldestModelsDevCacheEntries(options: {
  readonly cacheDir: string;
  readonly preservedCachePath: string;
}): Promise<void> {
  const entries = await validatedDiskEntries(options.cacheDir);
  const evictionCount = entries.length - MODELS_DEV_CACHE_MAX_ENTRIES;
  if (evictionCount <= 0) return;

  const oldestEntries = entries
    .filter((entry) => entry.cachePath !== options.preservedCachePath)
    .sort(compareOldestCacheEntries)
    .slice(0, evictionCount);

  for (const entry of oldestEntries) {
    try {
      await removeValidatedCacheEntry(entry);
    } catch {
      // Keep pruning other candidates when one cache entry cannot be removed.
    }
  }
}

async function readCachedSnapshot(
  identity: ModelsDevCacheIdentity,
): Promise<ModelsDevCatalogSnapshot | null> {
  const remembered = snapshots.get(identity.cacheKey);
  if (remembered !== undefined) return cloneSnapshot(remembered);

  const file = await readBoundedCacheFile(identity.cachePath);
  if (file === null) return null;

  const parsed = parseModelsDevCacheRecord(file.raw);
  if (
    parsed === null ||
    parsed.sourceUrl !== identity.sourceUrl ||
    parsed.parserVersion !== identity.parserVersion
  ) {
    return null;
  }

  const snapshot = snapshotFromRecord(parsed);
  rememberSnapshot(identity.cacheKey, snapshot);
  return cloneSnapshot(snapshot);
}

async function persistSnapshot(
  identity: ModelsDevCacheIdentity,
  snapshot: ModelsDevCatalogSnapshot,
): Promise<void> {
  await writeSecureFileAsync(identity.cachePath, JSON.stringify(recordFromSnapshot(snapshot)));
  try {
    await evictOldestModelsDevCacheEntries({
      cacheDir: dirname(identity.cachePath),
      preservedCachePath: identity.cachePath,
    });
  } catch {
    // The completed atomic write remains a successful cache outcome when pruning is unavailable.
  }
}

function withinCacheTtl(snapshot: ModelsDevCatalogSnapshot, now: number): boolean {
  return (
    now >= snapshot.validatedAt && now - snapshot.validatedAt < MODELS_DEV_CATALOG_CACHE_TTL_MS
  );
}

function responseEtag(response: Response): string | undefined {
  const etag = response.headers.get('etag');
  if (etag === null || etag.length === 0 || etag.length > MODELS_DEV_ETAG_MAX_LENGTH) {
    return undefined;
  }
  return etag;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

async function readBoundedResponseText(
  options: Readonly<{
    response: Response;
    maxPayloadBytes: number;
    signal: AbortSignal;
  }>,
): Promise<string | null> {
  throwIfAborted(options.signal);
  const contentLength = options.response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > options.maxPayloadBytes
    ) {
      await cancelResponseBody(options.response);
      return null;
    }
  }

  if (options.response.body === null) return '';
  const reader = options.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const cancelOnAbort = () => {
    void reader.cancel(options.signal.reason).catch(() => undefined);
  };
  options.signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(options.signal);
      const next = await reader.read();
      throwIfAborted(options.signal);
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > options.maxPayloadBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    options.signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }

  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    receivedBytes,
  );
  return body.toString('utf8');
}

function failureFromCause(cause: unknown): ModelsDevCacheFailure {
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return cacheFailure('timeout', 'Models.dev catalog request timed out.');
  }

  if (cause instanceof Error && cause.name === 'AbortError') {
    return cacheFailure('timeout', 'Models.dev catalog request timed out.');
  }

  return cacheFailure('request-failed', 'Models.dev catalog request failed.');
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
