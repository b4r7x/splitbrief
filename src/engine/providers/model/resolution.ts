import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import { isAutomaticModel, resolveCliModel } from '../../../core/providers/automatic-model.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import { KNOWN_MODELS, knownModelAnswersTo } from '../../../core/providers/known-models.js';
import type { ProviderId, RunnerKind } from '../../../core/schemas/enums.js';
import { isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { findCatalogModelByIdentity, getModelsForProvider } from '../models-dev/catalog.js';
import { matchesModelsDevId, splitModelVendorPrefix } from './parsing.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { DetectedModelFact } from '../../../core/runners/capabilities.js';
import { resolveAutoModel } from '../../../core/providers/model-selection.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import {
  getBundledModels,
  getRuntimeModelSnapshot,
  type ModelCacheAccessor,
} from './runtime-snapshot.js';

export type ExactModelLookup =
  | Readonly<{ kind: 'found'; model: DetectedModel }>
  | Readonly<{ kind: 'not-found' }>
  | Readonly<{ kind: 'ambiguous'; models: readonly DetectedModel[] }>;

/**
 * Shared by both lookup lanes, so both read through the `[1m]`/`[2m]` window suffix:
 * `resolveExactModelsDevModel` over models.dev entries and `resolveExactRuntimeModel` over a
 * runner's own listing. No listing ships a bracketed id today; one carrying both `x` and
 * `x[1m]` would match twice and resolve as `ambiguous` rather than picking a side.
 */
function exactLookup(
  input: Readonly<{
    entries: readonly DetectedModel[];
    selectionId: string;
    sourceProviderId?: string | undefined;
  }>,
): ExactModelLookup {
  const matches = input.entries.filter(
    (entry) =>
      matchesModelsDevId({ left: entry.id, right: input.selectionId }) &&
      (input.sourceProviderId === undefined || entry.providerId === input.sourceProviderId),
  );
  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length === 1) {
    const [model] = matches;
    if (model !== undefined) return { kind: 'found', model };
  }
  return { kind: 'ambiguous', models: matches };
}

/**
 * models.dev rows exist for `api` runners only. A `cli` runner's rows come from
 * its own listing, and a CLI-named `api` runner is a custom endpoint, so the
 * name alone only decides the lane for legacy callers that pass no kind.
 */
export function getModelsDevEntries(input: {
  providerId: ProviderId;
  cache: ModelCacheAccessor;
  kind?: RunnerKind | undefined;
}): DetectedModel[] {
  const { providerId, cache, kind } = input;
  if (kind === 'cli' || (kind === undefined && isCliToolId(providerId))) return [];
  const catalog = cache.getModelsDevCatalog();
  if (!catalog) return [];
  return getModelsForProvider(catalog, providerId);
}

export function resolveExactModelsDevModel(
  input: Readonly<{
    providerId: ProviderId;
    selectionId: string;
    cache: ModelCacheAccessor;
    sourceProviderId?: string | undefined;
    kind?: RunnerKind | undefined;
  }>,
): ExactModelLookup {
  return exactLookup({
    entries: getModelsDevEntries({
      providerId: input.providerId,
      cache: input.cache,
      kind: input.kind,
    }),
    selectionId: input.selectionId,
    ...(input.sourceProviderId === undefined ? {} : { sourceProviderId: input.sourceProviderId }),
  });
}

export function resolveExactRuntimeModel(
  input: Readonly<{
    providerId: ProviderId;
    selectionId: string;
    cache: ModelCacheAccessor;
    sourceProviderId?: string | undefined;
    role?: ActiveRunnerRole | undefined;
    kind?: RunnerKind | undefined;
  }>,
): ExactModelLookup {
  const snapshot = getRuntimeModelSnapshot(input);
  if (snapshot === null) return { kind: 'not-found' };
  return exactLookup({
    entries: snapshot.entries,
    selectionId: input.selectionId,
    ...(input.sourceProviderId === undefined ? {} : { sourceProviderId: input.sourceProviderId }),
  });
}

export function lookupModelsDevModel(input: {
  providerId: ProviderId;
  modelId: string;
  cache: ModelCacheAccessor;
  kind?: RunnerKind | undefined;
}): DetectedModel | null {
  const { providerId, modelId, cache, kind } = input;
  const outcome = resolveExactModelsDevModel({
    providerId,
    selectionId: modelId,
    cache,
    ...(kind === undefined ? {} : { kind }),
  });
  return outcome.kind === 'found' ? outcome.model : null;
}

/**
 * The image fact of a seat's own model. A CLI seat reads its tool's own listing for the pinned
 * model; an API seat reads its runtime row first, then models.dev. Absent for a seat of another
 * kind, an automatic CLI model, and when no lookup knows the fact.
 */
export function resolveSeatImageFact(
  input: Readonly<{
    runner: RunnerConfig;
    role: ActiveRunnerRole;
    cache: ModelCacheAccessor | undefined;
  }>,
): DetectedModelFact | undefined {
  const { runner, cache } = input;
  if (cache === undefined) return undefined;
  if (runner.kind === 'cli') {
    const model = resolveCliModel(runner.model, runner.tool);
    if (model === undefined || !isCliToolId(runner.tool)) return undefined;
    const runtime = resolveExactRuntimeModel({
      providerId: runner.tool,
      selectionId: model,
      cache,
      role: input.role,
      kind: 'cli',
    });
    const supportsImages = runtime.kind === 'found' ? runtime.model.supportsImages : undefined;
    return supportsImages === undefined ? undefined : { supportsImages };
  }
  if (runner.kind !== 'api' || !isProviderId(runner.provider)) return undefined;
  const modelId = resolveAutoModel(runner.model, runner.provider);
  if (modelId === undefined) return undefined;
  const lookup = { providerId: runner.provider, modelId, cache, kind: runner.kind };
  const runtime = resolveExactRuntimeModel({ ...lookup, selectionId: modelId, role: input.role });
  const supportsImages =
    (runtime.kind === 'found' ? runtime.model.supportsImages : undefined) ??
    lookupModelsDevModel(lookup)?.supportsImages;
  return supportsImages === undefined ? undefined : { supportsImages };
}

export function lookupRuntimeModel(input: {
  providerId: ProviderId;
  modelId: string;
  cache: ModelCacheAccessor;
  kind?: RunnerKind | undefined;
}): DetectedModel | null {
  const { providerId, modelId, cache, kind } = input;
  const outcome = resolveExactRuntimeModel({
    providerId,
    selectionId: modelId,
    cache,
    ...(kind === undefined ? {} : { kind }),
  });
  return outcome.kind === 'found' ? outcome.model : null;
}

/**
 * Bundled lookup for a runner with no bundled provider of its own. KNOWN_MODELS
 * is provider-keyed, so a custom endpoint's model can only be found by scanning
 * every provider for a row that answers to the model id — with or without a
 * `vendor/` prefix.
 */
export function findKnownModelByModelId(modelId: string): KnownModel | undefined {
  const { bareId } = splitModelVendorPrefix(modelId);
  for (const models of Object.values(KNOWN_MODELS)) {
    const match = models.find(
      (entry) => knownModelAnswersTo(entry, modelId) || knownModelAnswersTo(entry, bareId),
    );
    if (match !== undefined) return match;
  }
  return undefined;
}

export function lookupCatalogModelByModelId(
  modelId: string,
  cache: ModelCacheAccessor,
): DetectedModel | null {
  const catalog = cache.getModelsDevCatalog();
  if (catalog === null) return null;
  return findCatalogModelByIdentity(catalog, splitModelVendorPrefix(modelId));
}

function getDefaultKnownModel(providerId: ProviderId): KnownModel | undefined {
  return getBundledModels(providerId).find((entry) => entry.isDefault);
}

export function getEffectiveModelId(providerId: ProviderId, modelId?: string): string | undefined {
  // Provider-aware: claude-code's legacy `default` alias means automatic too, so a seat still
  // carrying it must not be resolved as a model literally named `default`. A provider-blind
  // comparison here left such a seat with no context window at all once the `default` row went.
  if (modelId !== undefined && modelId.trim() !== '' && !isAutomaticModel(modelId, providerId)) {
    return modelId;
  }

  const fallback = getDefaultKnownModel(providerId);
  return fallback?.catalogModelId ?? fallback?.name;
}
