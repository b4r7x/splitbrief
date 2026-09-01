import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { ModelsDevCatalogSchema, type ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { writeSecureFileAsync } from '../../../lib/fs.js';
import { error } from '../../../utils/error.js';
import type {
  ModelsDevCatalogCacheOptions,
  ModelsDevCatalogSnapshot,
} from '../models-dev-cache.js';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/api.json';
export const MODELS_DEV_CATALOG_PARSER_VERSION = 'models-dev-api-json-v1';
export const MODELS_DEV_CATALOG_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MODELS_DEV_ETAG_MAX_LENGTH = 4_096;

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
const MODELS_DEV_SOURCE_URL_MAX_LENGTH = 2_048;

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

export interface ModelsDevCacheIdentity {
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

export function cacheIdentity(options: ModelsDevCatalogCacheOptions): ModelsDevCacheIdentity {
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

export function catalogState(catalog: ModelsDevCatalog): ModelsDevCatalogSnapshot['catalogState'] {
  return Object.keys(catalog).length === 0 ? 'empty' : 'populated';
}

export function cloneSnapshot(snapshot: ModelsDevCatalogSnapshot): ModelsDevCatalogSnapshot {
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

export function rememberSnapshot(cacheKey: string, snapshot: ModelsDevCatalogSnapshot): void {
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

export async function readCachedSnapshot(
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

export async function persistSnapshot(
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
