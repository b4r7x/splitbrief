import type { DetectedModel } from '../../../core/discovery/detection.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import {
  isApiProviderId,
  type ApiProviderId,
} from '../../../core/providers/api-provider-catalog.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import { KNOWN_MODELS, knownModelAnswersTo } from '../../../core/providers/known-models.js';
import type { ProviderId, RunnerKind } from '../../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import {
  CLI_TOOL_IDS,
  isCliToolId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { ConfiguredProviderRuntime } from '../../detection/provider-outcomes.js';
import type { ScopedCliCatalogRuntime } from '../../detection/cli-catalog-outcomes.js';
import { findCatalogModelByIdentity, getModelsForProvider } from '../models-dev.js';
import type { ClaudeCodeModelOption } from '../../../core/providers/claude-code-options.js';
import { matchesModelsDevId, splitModelVendorPrefix } from './parsing.js';
import { includes } from '../../../utils/type-guards.js';

export interface ModelCacheAccessor {
  getModelsDevCatalog(): ModelsDevCatalog | null;
  /**
   * Remembered provider rows. `kind` names the caller's runner kind, so an API
   * runner whose name is also a CLI tool id never reads the CLI catalog lane;
   * absent keeps the legacy name-only lookup.
   */
  getProviderModels(providerId: ProviderId, kind?: RunnerKind): readonly DetectedModel[] | null;
  /** Staleness of the generic memory backing getProviderModels (remembered rows). */
  isProviderModelCacheStale?(providerId: ProviderId, kind?: RunnerKind): boolean;
  /**
   * Current role-scoped API membership. When present, this is authoritative
   * for API model lookup and prevents ambiguous generic reuse.
   */
  getScopedProviderRuntime?(
    input: Readonly<{ role: ActiveRunnerRole; provider: ApiProviderId }>,
  ): ConfiguredProviderRuntime | null | undefined;
  /** Exact tool/context CLI membership; null is authoritative absence. */
  getCliCatalogRuntime?(
    input: Readonly<{ tool: CliToolId }>,
  ): ScopedCliCatalogRuntime | null | undefined;
  /** Claude Code's local `~/.claude.json` option cache; absent means no options. */
  getClaudeCodeModelOptions?(): readonly ClaudeCodeModelOption[];
}

export const NULL_CACHE: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

export type ExactModelLookup =
  | Readonly<{ kind: 'found'; model: DetectedModel }>
  | Readonly<{ kind: 'not-found' }>
  | Readonly<{ kind: 'ambiguous'; models: readonly DetectedModel[] }>;

export interface RuntimeModelSnapshot {
  readonly providerId: ProviderId;
  readonly entries: readonly DetectedModel[];
  readonly isStale: boolean;
}

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

export function getBundledModels(providerId: ProviderId): readonly KnownModel[] {
  return KNOWN_MODELS[providerId] ?? [];
}

function scopedRuntimeProvider(providerId: ProviderId): ApiProviderId | null {
  return isApiProviderId(providerId) ? providerId : null;
}

function scopedCliTool(providerId: ProviderId, kind?: RunnerKind): CliToolId | null {
  // An `api` runner reads API lanes only: `provider: opencode` is a custom HTTP
  // endpoint that reuses the tool's name, never the local OpenCode CLI catalog.
  if (kind === 'api') return null;
  return includes(CLI_TOOL_IDS, providerId) ? providerId : null;
}

/**
 * Resolves a role-scoped runtime snapshot when the cache can provide one.
 * `undefined` means a non-API runner or legacy cache. `null` is an
 * authoritative scoped absence, while an existing empty/failed record is also
 * authoritative and cannot fall back to generic provider memory.
 */
export function getScopedRuntimeSnapshot(
  input: Readonly<{
    providerId: ProviderId;
    role?: ActiveRunnerRole | undefined;
    cache: ModelCacheAccessor;
    kind?: RunnerKind | undefined;
  }>,
): RuntimeModelSnapshot | undefined {
  if (input.role === undefined) return undefined;
  const cliTool = scopedCliTool(input.providerId, input.kind);
  if (cliTool !== null && input.cache.getCliCatalogRuntime !== undefined) {
    const runtime = input.cache.getCliCatalogRuntime({ tool: cliTool });
    if (runtime === undefined) return undefined;
    return {
      providerId: cliTool,
      entries: runtime?.models ?? [],
      isStale: runtime?.state === 'stale',
    };
  }
  if (input.cache.getScopedProviderRuntime === undefined) return undefined;
  const provider = scopedRuntimeProvider(input.providerId);
  if (provider === null) return undefined;
  const runtime = input.cache.getScopedProviderRuntime({ role: input.role, provider });
  if (runtime === undefined) return undefined;
  return {
    providerId: provider,
    entries: runtime?.models ?? [],
    isStale: runtime?.state === 'stale',
  };
}

export function getRuntimeModelSnapshot(
  input: Readonly<{
    providerId: ProviderId;
    role?: ActiveRunnerRole | undefined;
    cache: ModelCacheAccessor;
    kind?: RunnerKind | undefined;
  }>,
): RuntimeModelSnapshot | null {
  const scoped = getScopedRuntimeSnapshot(input);
  if (scoped !== undefined) return scoped;
  const runtimeProviderId = input.providerId;
  const entries = input.cache.getProviderModels(runtimeProviderId, input.kind);
  if (entries === null) return null;
  return {
    providerId: runtimeProviderId,
    entries,
    isStale: input.cache.isProviderModelCacheStale?.(runtimeProviderId, input.kind) ?? false,
  };
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
