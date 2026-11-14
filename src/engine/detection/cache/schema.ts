import { join } from 'node:path';
import { z } from 'zod';
import { MAX_CLI_CATALOG_READ_MODELS } from '../../../core/discovery/catalog-read-merge.js';
import {
  CliExecutableFingerprintSchema,
  type CliExecutableFingerprint,
} from '../../../core/discovery/detection/executable.js';
import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import {
  ProviderDetectionSchema,
  CliTrustStateSchema,
  CliCompatibilityStateSchema,
  CliAuthStateSchema,
  CliReadinessStateSchema,
  type ProviderDetection,
  type CliToolDetection,
} from '../../../core/discovery/detection/tool.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { CLI_AUTH_CHANNEL_IDS } from '../../../core/runners/cli-tool/auth-channels.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { CacheVersionStringBaseSchema } from '../../../core/schemas/cache-version.js';
import { CliToolIdSchema } from '../../../core/schemas/enums.js';

export const CACHE_FILENAME = 'detection-cache.json';
export const DEFAULT_TTL_MS = 5 * 60 * 1_000;
export const DETECTION_CACHE_VERSION = 7;
const MAX_CACHE_ENTRIES = 100;
// The generated key embeds a percent-encoded project path plus two runner
// contexts; a PATH_MAX-sized path alone can expand beyond 12 KiB.
const MAX_CACHE_CONTEXT_KEY_LENGTH = 16 * 1_024;
export const CACHE_RELATIVE_PATH = join(SPLITBRIEF_DIR, CACHE_FILENAME);

export function hasSensitiveCacheValue(value: string): boolean {
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

/**
 * A generated context key names the selected auth channel — one channel is
 * literally called `api-key` — and, for an env-referenced credential, the
 * variable's name, which is `OPENAI_API_KEY` for most users. Both are names of
 * credentials rather than credentials, yet either is enough to trip the
 * heuristic and silently disable the cache for the runners that carry them. The
 * vocabulary is closed, so it is removed before the scan instead of widening the
 * pattern the scan uses; what survives the strip is still checked for real key
 * material. Version strings and model ids keep the unmodified check.
 */
const CACHE_CONTEXT_NAME_TOKENS = new RegExp(
  [...CLI_AUTH_CHANNEL_IDS, 'api[-_]?key', 'bearer', 'password', 'secret', 'token'].join('|'),
  'gi',
);

const CacheContextKeySchema = z
  .string()
  .min(1)
  .max(MAX_CACHE_CONTEXT_KEY_LENGTH)
  .regex(/^[A-Za-z0-9._~|%=-]+$/)
  .refine((value) => {
    const scanned = value.replace(CACHE_CONTEXT_NAME_TOKENS, '');
    return !hasSensitiveCacheValue(scanned) && !hasPrivateContextIdentifier(scanned);
  }, 'Cache context must not include credential material, hashes, or private identifiers');

const CacheVersionStringSchema = CacheVersionStringBaseSchema.refine(
  (value) => !hasSensitiveCacheValue(value),
  'Cache version metadata must not include credential material or hashes',
);

export const MAX_CACHED_MODELS_PER_ENTRY = 500;

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
 * Sanitized projection of a detected model. Remembered rows carry identity,
 * the tool's own display name and detail, sizing, ordering, the effort ladder
 * and its default and the modality flags, so a cold start can paint the picker
 * before the live refresh lands. The hidden flag is a public catalog value from
 * the tool's own listing, not credential or account material. Capability facts
 * ride along so a cold start drops the embedding rows a live refresh would
 * drop, and the image fact so a command that reads no live listing does not
 * count a text-only model as one that reads images. An optional field needs no
 * version bump: a record without it still parses, and an older build's strict
 * schema rejects a record with it, which it reads as no record at all — what a
 * bump would do.
 */
export const CachedModelSchema = z
  .object({
    id: CachedModelIdSchema,
    displayName: z.string().min(1).max(256).optional(),
    detail: z.string().min(1).max(512).optional(),
    contextLength: z.number().int().positive().optional(),
    releaseDate: z.iso.date().optional(),
    nativeOrder: z.number().int().nonnegative().optional(),
    nativeDefault: z.boolean().optional(),
    nativeHidden: z.boolean().optional(),
    nativeReasoningEfforts: z.array(z.string().trim().min(1).max(64)).max(32).readonly().optional(),
    nativeDefaultReasoningEffort: z.string().trim().min(1).max(64).optional(),
    supportsToolCalls: z.boolean().optional(),
    supportsImages: z.boolean().optional(),
    outputModalities: z.array(z.string().min(1).max(32)).max(8).readonly().optional(),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    isFree: z.boolean().optional(),
  })
  .strict();

const CachedModelsSchema = z.array(CachedModelSchema).max(MAX_CACHED_MODELS_PER_ENTRY).readonly();

export const CachedCliCatalogSchema = z
  .object({
    tool: CliToolIdSchema,
    models: z
      .array(CachedModelSchema)
      .max(MAX_CLI_CATALOG_READ_MODELS * 2)
      .readonly(),
    missingOnce: z
      .array(CachedModelIdSchema)
      .max(MAX_CLI_CATALOG_READ_MODELS)
      .readonly()
      .optional(),
    /** Absent on lists read without naming the project, and on lists an earlier release saved. */
    namesProject: z.literal(true).optional(),
    probedAt: z.number().int().nonnegative(),
  })
  .strict();

export const CachedProviderDetectionSchema = ProviderDetectionSchema.pick({
  provider: true,
  available: true,
  isLocal: true,
  hasKey: true,
  failure: true,
})
  .extend({ models: CachedModelsSchema.optional() })
  .strict();

export const CachedCliToolDetectionSchema = z
  .object({
    tool: CliToolIdSchema,
    trust: CliTrustStateSchema,
    installedVersion: CacheVersionStringSchema.nullable(),
    testedVersion: CacheVersionStringSchema,
    compatibility: CliCompatibilityStateSchema,
    auth: CliAuthStateSchema,
    /** Raw as persisted — vintages differ, so `normalizeProviderAuth` decides the shape on load. */
    providerAuth: z.unknown().optional(),
    diagnosticState: CliReadinessStateSchema,
    probedAt: z.number().int().nonnegative(),
    fingerprint: CliExecutableFingerprintSchema.nullable(),
  })
  .strict();

export const DetectionCacheSchema = z
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

export type DetectionCache = z.infer<typeof DetectionCacheSchema>;
export type CachedCliToolDetection = z.infer<typeof CachedCliToolDetectionSchema>;
export type CachedModel = z.infer<typeof CachedModelSchema>;

/** Remembered model catalog for one configured CLI runner. */
export interface RememberedCliCatalog {
  readonly tool: CliToolId;
  readonly models: readonly DetectedModel[];
  readonly missingOnce?: readonly string[] | undefined;
  /** The read named the project, so the list carries the providers the project's own config sets up. */
  readonly namesProject?: boolean | undefined;
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

export interface RememberedPresentation {
  readonly snapshot: DetectionCacheSnapshot;
  readonly foreignContext: boolean;
}

export interface RememberedCliRuntime {
  readonly installedVersion: string;
  readonly fingerprint: CliExecutableFingerprint;
}
