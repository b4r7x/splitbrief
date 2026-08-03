import { join, relative } from 'node:path';
import { z } from 'zod';
import { confinedReadFileAsync, confinedUnlinkSync } from '../../lib/confined-fs.js';
import { writeConfinedSecureFileAsync } from '../../lib/fs.js';
import {
  CliExecutableFingerprintSchema,
  CliAuthStateSchema,
  CliCompatibilityStateSchema,
  CliProviderAuthFactSchema,
  CliReadinessStateSchema,
  CliTrustStateSchema,
  CliToolDetectionSchema,
  ProviderDetectionSchema,
  type CliToolDetection,
  type ProviderDetection,
} from '../../core/discovery/detection.js';
import type { ActiveRunnerRole } from '../../core/config/accessors/active-runner.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { getSplitbriefPath, SPLITBRIEF_DIR } from '../../core/paths.js';
import { CliToolIdSchema } from '../../core/schemas/enums.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';

const CACHE_FILENAME = 'detection-cache.json';
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DETECTION_CACHE_VERSION = 3;
const MAX_CACHE_ENTRIES = 100;
// The generated key embeds a percent-encoded project path plus two runner
// contexts; a PATH_MAX-sized path alone can expand beyond 12 KiB.
const MAX_CACHE_CONTEXT_KEY_LENGTH = 16 * 1_024;
const CACHE_RELATIVE_PATH = join(SPLITBRIEF_DIR, CACHE_FILENAME);
const LEGACY_CONTEXT_KEY = 'legacy-detection-cache';

function hasSensitiveCacheValue(value: string): boolean {
  return (
    /(?:^|[^a-z0-9])(?:sk-|gsk_|rk_)/i.test(value) ||
    /(?:^|[^a-z0-9])(?:bearer|api[-_]?key|password|secret|token|sha(?:-?256)?)(?=$|[^a-z0-9])/i.test(
      value,
    ) ||
    /[a-f0-9]{64}/i.test(value)
  );
}

function hasPrivateContextIdentifier(value: string): boolean {
  return (
    /(?:^|[^a-z0-9])(?:acct_|org_)/i.test(value) ||
    /(?:^|[^a-z0-9])(?:account[-_]?|organization[-_]?|local|model|private)(?=$|[^a-z0-9])/i.test(
      value,
    )
  );
}

const CacheContextKeySchema = z
  .string()
  .min(1)
  .max(MAX_CACHE_CONTEXT_KEY_LENGTH)
  .regex(/^[A-Za-z0-9._~|%=-]+$/)
  .refine(
    (value) => !hasSensitiveCacheValue(value) && !hasPrivateContextIdentifier(value),
    'Cache context must not include credential material, hashes, or private identifiers',
  );

const CacheVersionStringSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
  .refine(
    (value) => !hasSensitiveCacheValue(value),
    'Cache version metadata must not include credential material or hashes',
  );

const MAX_CACHED_MODELS_PER_ENTRY = 500;

const CachedModelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.@:/+-]+$/)
  .refine(
    (value) => !hasSensitiveCacheValue(value),
    'Cached model ids must not include credential material or hashes',
  );

/**
 * Presentation-only projection of a detected model. Pricing, modality, and
 * provenance fields stay memory-only; remembered rows only need identity,
 * sizing, and ordering to render a picker before the live refresh lands.
 */
const CachedModelSchema = z
  .object({
    id: CachedModelIdSchema,
    contextLength: z.number().int().positive().optional(),
    releaseDate: z.iso.date().optional(),
    nativeOrder: z.number().int().nonnegative().optional(),
    nativeDefault: z.boolean().optional(),
    isFree: z.boolean().optional(),
  })
  .strict();

const CachedModelsSchema = z.array(CachedModelSchema).max(MAX_CACHED_MODELS_PER_ENTRY).readonly();

const CachedCliCatalogSchema = z
  .object({
    role: z.enum(['planner', 'implementer']),
    tool: CliToolIdSchema,
    models: CachedModelsSchema,
    probedAt: z.number().int().nonnegative(),
  })
  .strict();

const CachedProviderDetectionSchema = ProviderDetectionSchema.pick({
  provider: true,
  available: true,
  isLocal: true,
  hasKey: true,
  failure: true,
})
  .extend({ models: CachedModelsSchema.optional() })
  .strict();

const CachedCliToolDetectionSchema = z
  .object({
    tool: CliToolIdSchema,
    trust: CliTrustStateSchema,
    installedVersion: CacheVersionStringSchema.nullable(),
    testedVersion: CacheVersionStringSchema,
    compatibility: CliCompatibilityStateSchema,
    auth: CliAuthStateSchema,
    /** Absent on rows cached before per-provider oracle facts existed. */
    providerAuth: z.array(CliProviderAuthFactSchema).max(64).readonly().optional(),
    diagnosticState: CliReadinessStateSchema,
    probedAt: z.number().int().nonnegative(),
    fingerprint: CliExecutableFingerprintSchema.nullable(),
  })
  .strict();

const DetectionCacheSchema = z
  .object({
    version: z.literal(DETECTION_CACHE_VERSION),
    contextKey: CacheContextKeySchema,
    fetchedAt: z.number().int().nonnegative(),
    validatedAt: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    requestId: z.number().int().nonnegative(),
    providers: z.array(CachedProviderDetectionSchema).max(MAX_CACHE_ENTRIES),
    cliTools: z.array(CachedCliToolDetectionSchema).max(MAX_CACHE_ENTRIES),
    /** Absent on rows cached before remembered model catalogs existed. */
    cliCatalogs: z.array(CachedCliCatalogSchema).max(MAX_CACHE_ENTRIES).optional(),
  })
  .strict();

type DetectionCache = z.infer<typeof DetectionCacheSchema>;
type CachedCliToolDetection = z.infer<typeof CachedCliToolDetectionSchema>;
type CachedModel = z.infer<typeof CachedModelSchema>;

/** Presentation-only remembered model catalog for one configured CLI runner. */
export interface RememberedCliCatalog {
  readonly role: ActiveRunnerRole;
  readonly tool: CliToolId;
  readonly models: readonly DetectedModel[];
  readonly probedAt: number;
}

export interface DetectionCacheSnapshot {
  readonly contextKey: string;
  readonly fetchedAt: number;
  readonly validatedAt: number;
  readonly generation: number;
  readonly requestId: number;
  readonly providers: ProviderDetection[];
  readonly cliTools: CliToolDetection[];
  readonly cliCatalogs?: readonly RememberedCliCatalog[] | undefined;
}

export interface SaveDetectionCacheInput {
  readonly projectDir: string;
  readonly snapshot: DetectionCacheSnapshot;
}

function cachePath(projectDir: string): string {
  return getSplitbriefPath(projectDir, CACHE_FILENAME);
}

function parseCache(value: unknown): DetectionCache | null {
  const result = DetectionCacheSchema.safeParse(value);
  return result.success ? result.data : null;
}

function isLegacyPrivateCache(value: unknown): value is Readonly<{ version: 1 | 2 }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'version' in value &&
    (value.version === 1 || value.version === 2)
  );
}

function cacheDiagnostic(
  state: CliToolDetection['diagnostic']['state'],
): CliToolDetection['diagnostic'] {
  if (state === 'ready') return { state, remediation: null };
  return { state, remediation: 'Run runner readiness again.' };
}

function restoreCliTool(cached: CachedCliToolDetection): CliToolDetection | null {
  const result = CliToolDetectionSchema.safeParse({
    tool: cached.tool,
    executable: null,
    trust: cached.trust,
    installedVersion: cached.installedVersion,
    testedVersion: cached.testedVersion,
    compatibility: cached.compatibility,
    auth: cached.auth,
    ...(cached.providerAuth === undefined ? {} : { providerAuth: cached.providerAuth }),
    diagnostic: cacheDiagnostic(cached.diagnosticState),
    probedAt: cached.probedAt,
  });
  return result.success ? result.data : null;
}

/** Projects models to the cached subset, dropping any row that fails sanitization. */
function cachedModels(models: readonly DetectedModel[]): CachedModel[] {
  const sanitized: CachedModel[] = [];
  for (const model of models) {
    if (sanitized.length >= MAX_CACHED_MODELS_PER_ENTRY) break;
    const result = CachedModelSchema.safeParse({
      id: model.id,
      ...(model.contextLength === undefined ? {} : { contextLength: model.contextLength }),
      // A non-ISO release date drops the field, not the whole row.
      ...(model.releaseDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(model.releaseDate)
        ? {}
        : { releaseDate: model.releaseDate }),
      ...(model.nativeOrder === undefined ? {} : { nativeOrder: model.nativeOrder }),
      ...(model.nativeDefault === undefined ? {} : { nativeDefault: model.nativeDefault }),
      ...(model.isFree === undefined ? {} : { isFree: model.isFree }),
    });
    if (result.success) sanitized.push(result.data);
  }
  return sanitized;
}

function cachedProvider(
  provider: ProviderDetection,
): z.input<typeof CachedProviderDetectionSchema> {
  return {
    provider: provider.provider,
    available: provider.available,
    isLocal: provider.isLocal,
    ...(provider.hasKey === undefined ? {} : { hasKey: provider.hasKey }),
    ...(provider.failure === undefined ? {} : { failure: provider.failure }),
    ...(provider.models === undefined ? {} : { models: cachedModels(provider.models) }),
  };
}

function cachedCliCatalog(catalog: RememberedCliCatalog): z.input<typeof CachedCliCatalogSchema> {
  return {
    role: catalog.role,
    tool: catalog.tool,
    models: cachedModels(catalog.models),
    probedAt: catalog.probedAt,
  };
}

function cachedCliTool(cli: CliToolDetection): z.input<typeof CachedCliToolDetectionSchema> {
  return {
    tool: cli.tool,
    trust: cli.trust,
    installedVersion: cli.installedVersion,
    testedVersion: cli.testedVersion,
    compatibility: cli.compatibility,
    auth: cli.auth,
    ...(cli.providerAuth === undefined ? {} : { providerAuth: cli.providerAuth }),
    diagnosticState: cli.diagnostic.state,
    probedAt: cli.probedAt,
    fingerprint: cli.executable === null ? null : cli.executable.fingerprint,
  };
}

function buildCache(snapshot: DetectionCacheSnapshot): DetectionCache | null {
  const result = DetectionCacheSchema.safeParse({
    version: DETECTION_CACHE_VERSION,
    contextKey: snapshot.contextKey,
    fetchedAt: snapshot.fetchedAt,
    validatedAt: snapshot.validatedAt,
    generation: snapshot.generation,
    requestId: snapshot.requestId,
    providers: snapshot.providers.map(cachedProvider),
    cliTools: snapshot.cliTools.map(cachedCliTool),
    ...(snapshot.cliCatalogs === undefined || snapshot.cliCatalogs.length === 0
      ? {}
      : { cliCatalogs: snapshot.cliCatalogs.map(cachedCliCatalog) }),
  });
  return result.success ? result.data : null;
}

function snapshotFromCache(cache: DetectionCache): DetectionCacheSnapshot | null {
  const cliTools: CliToolDetection[] = [];
  for (const cachedCliTool of cache.cliTools) {
    const cliTool = restoreCliTool(cachedCliTool);
    if (cliTool === null) return null;
    cliTools.push(cliTool);
  }

  return {
    contextKey: cache.contextKey,
    fetchedAt: cache.fetchedAt,
    validatedAt: cache.validatedAt,
    generation: cache.generation,
    requestId: cache.requestId,
    providers: cache.providers.map(({ models, ...provider }) => ({
      ...provider,
      ...(models === undefined ? {} : { models: models.map((model) => ({ ...model })) }),
    })),
    cliTools,
    ...(cache.cliCatalogs === undefined
      ? {}
      : { cliCatalogs: cache.cliCatalogs.map((catalog) => ({ ...catalog })) }),
  };
}

function legacySnapshot(
  providers: ProviderDetection[],
  cliTools: CliToolDetection[],
): DetectionCacheSnapshot {
  const observedAt = Date.now();
  return {
    contextKey: LEGACY_CONTEXT_KEY,
    fetchedAt: observedAt,
    validatedAt: observedAt,
    generation: 0,
    requestId: 0,
    providers,
    cliTools,
  };
}

function isSaveInput(value: SaveDetectionCacheInput | string): value is SaveDetectionCacheInput {
  return typeof value !== 'string';
}

async function readCacheRaw(projectDir: string): Promise<unknown | null> {
  try {
    const raw = await confinedReadFileAsync(projectDir, CACHE_RELATIVE_PATH);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readCache(projectDir: string): Promise<DetectionCache | null> {
  const raw = await readCacheRaw(projectDir);
  if (isLegacyPrivateCache(raw)) {
    try {
      // Versions 1 and 2 persisted model inventories and diagnostics. Keep
      // the same confined unlink boundary as explicit invalidation, without
      // reading or propagating any of their private fields.
      confinedUnlinkSync(projectDir, CACHE_RELATIVE_PATH);
    } catch {
      // A cache cleanup failure is non-critical and must not bypass confinement.
    }
    return null;
  }
  return parseCache(raw);
}

/**
 * Reads a cache record only when its original non-secret context is identical
 * to the caller's current context. Disk snapshots are always stale at hydration.
 */
export async function loadDetectionCacheSnapshot(
  input: Readonly<{ projectDir: string; contextKey: string }>,
): Promise<DetectionCacheSnapshot | null> {
  const cache = await readCache(input.projectDir);
  if (cache === null || cache.contextKey !== input.contextKey) return null;
  return snapshotFromCache(cache);
}

/**
 * Legacy projection reader retained for callers that only need the sanitized
 * readiness projection. Coordinator-backed callers use loadDetectionCacheSnapshot.
 */
export async function loadDetectionCache(
  projectDir: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ providers: ProviderDetection[]; cliTools: CliToolDetection[] } | null> {
  const cache = await readCache(projectDir);
  if (
    cache === null ||
    cache.contextKey !== LEGACY_CONTEXT_KEY ||
    Date.now() - cache.fetchedAt >= ttlMs
  ) {
    return null;
  }
  const snapshot = snapshotFromCache(cache);
  if (snapshot === null) return null;
  return { providers: snapshot.providers, cliTools: snapshot.cliTools };
}

export function saveDetectionCache(input: SaveDetectionCacheInput): Promise<void>;
export function saveDetectionCache(
  projectDir: string,
  providers: ProviderDetection[],
  cliTools: CliToolDetection[],
): Promise<void>;
export async function saveDetectionCache(
  inputOrProjectDir: SaveDetectionCacheInput | string,
  providers?: ProviderDetection[],
  cliTools?: CliToolDetection[],
): Promise<void> {
  const input = isSaveInput(inputOrProjectDir)
    ? inputOrProjectDir
    : providers === undefined || cliTools === undefined
      ? null
      : {
          projectDir: inputOrProjectDir,
          snapshot: legacySnapshot(providers, cliTools),
        };
  if (input === null) return;

  const cache = buildCache(input.snapshot);
  if (cache === null) return;

  try {
    const path = cachePath(input.projectDir);
    await writeConfinedSecureFileAsync(
      input.projectDir,
      relative(input.projectDir, path),
      JSON.stringify(cache),
    );
  } catch {
    // Cache write failure is non-critical.
  }
}

export async function invalidateCache(projectDir: string): Promise<void> {
  try {
    confinedUnlinkSync(projectDir, CACHE_RELATIVE_PATH);
  } catch {
    // File doesn't exist or can't be deleted — non-critical.
  }
}
