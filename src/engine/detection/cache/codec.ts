import type { z } from 'zod';
import { normalizeProviderAuth } from '../../../core/discovery/detection/auth.js';
import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import {
  type CliToolDetection,
  CliToolDetectionSchema,
  type ProviderDetection,
} from '../../../core/discovery/detection/tool.js';
import { warnError } from '../../../lib/warn.js';
import {
  type CachedCliToolDetection,
  type CachedModel,
  CachedModelSchema,
  hasSensitiveCacheValue,
  type CachedProviderDetectionSchema,
  MAX_CACHED_MODELS_PER_ENTRY,
  type RememberedCliCatalog,
  type CachedCliCatalogSchema,
  type CachedCliToolDetectionSchema,
  type DetectionCacheSnapshot,
  type DetectionCache,
  DetectionCacheSchema,
  DETECTION_CACHE_VERSION,
  CACHE_RELATIVE_PATH,
} from './schema.js';

function cacheDiagnostic(
  state: CliToolDetection['diagnostic']['state'],
): CliToolDetection['diagnostic'] {
  if (state === 'ready') return { state, remediation: null };
  return { state, remediation: 'Press ctrl+r to check again.' };
}

function restoreCliTool(cached: CachedCliToolDetection): CliToolDetection | null {
  const providerAuth = normalizeProviderAuth({
    tool: cached.tool,
    providerAuth: cached.providerAuth,
  });
  const result = CliToolDetectionSchema.safeParse({
    tool: cached.tool,
    executable: null,
    trust: cached.trust,
    installedVersion: cached.installedVersion,
    testedVersion: cached.testedVersion,
    compatibility: cached.compatibility,
    auth: cached.auth,
    ...(providerAuth === undefined ? {} : { providerAuth }),
    diagnostic: cacheDiagnostic(cached.diagnosticState),
    probedAt: cached.probedAt,
  });
  return result.success ? result.data : null;
}

/** Projects models to the cached subset, dropping any row that fails sanitization. */
function cachedModels(models: readonly DetectedModel[], limit = models.length): CachedModel[] {
  const sanitized: CachedModel[] = [];
  for (const model of models) {
    if (sanitized.length >= limit) break;
    const result = CachedModelSchema.safeParse({
      id: model.id,
      ...(model.displayName === undefined || hasSensitiveCacheValue(model.displayName)
        ? {}
        : { displayName: model.displayName }),
      ...(model.detail === undefined || hasSensitiveCacheValue(model.detail)
        ? {}
        : { detail: model.detail }),
      ...(model.contextLength === undefined ? {} : { contextLength: model.contextLength }),
      // A non-ISO release date drops the field, not the whole row.
      ...(model.releaseDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(model.releaseDate)
        ? {}
        : { releaseDate: model.releaseDate }),
      ...(model.nativeOrder === undefined ? {} : { nativeOrder: model.nativeOrder }),
      ...(model.nativeDefault === undefined ? {} : { nativeDefault: model.nativeDefault }),
      ...(model.nativeHidden === undefined ? {} : { nativeHidden: model.nativeHidden }),
      ...(model.nativeReasoningEfforts === undefined
        ? {}
        : { nativeReasoningEfforts: [...model.nativeReasoningEfforts] }),
      ...(model.nativeDefaultReasoningEffort === undefined
        ? {}
        : { nativeDefaultReasoningEffort: model.nativeDefaultReasoningEffort }),
      ...(model.supportsToolCalls === undefined
        ? {}
        : { supportsToolCalls: model.supportsToolCalls }),
      ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
      ...(model.outputModalities === undefined
        ? {}
        : { outputModalities: [...model.outputModalities] }),
      ...(model.capabilities === undefined ? {} : { capabilities: [...model.capabilities] }),
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
    ...(provider.models === undefined
      ? {}
      : { models: cachedModels(provider.models, MAX_CACHED_MODELS_PER_ENTRY) }),
  };
}

function cachedCliCatalog(catalog: RememberedCliCatalog): z.input<typeof CachedCliCatalogSchema> {
  const models = cachedModels(catalog.models);
  const modelIds = new Set(models.map((model) => model.id));
  return {
    tool: catalog.tool,
    models,
    ...(catalog.missingOnce === undefined
      ? {}
      : { missingOnce: catalog.missingOnce.filter((id) => modelIds.has(id)) }),
    ...(catalog.namesProject === true ? { namesProject: true } : {}),
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

export function buildCache(snapshot: DetectionCacheSnapshot): DetectionCache | null {
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
  if (result.success) return result.data;
  // Field paths only: a rejected value is often the credential-shaped material
  // the schema refused, so it must not travel into a diagnostic line.
  const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
  warnError(
    `Could not save the tool check to ${CACHE_RELATIVE_PATH}, so the next start shows an older tool check, or none, until it checks your tools again. Fields not valid: ${fields}`,
  );
  return null;
}

export function snapshotFromCache(cache: DetectionCache): DetectionCacheSnapshot | null {
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
