import type { CredentialDomainIdentity } from '../../../core/config/accessors/runner-config.js';
import type { ActiveRunnerRole } from '../../../core/config/accessors/active-runner.js';
import { isSameCredentialDomain } from '../../../core/config/accessors/runner-config.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import { AUTOMATIC_MODEL } from '../../../core/providers/automatic-model.js';
import {
  isApiProviderId,
  type ApiProviderId,
} from '../../../core/providers/api-provider-catalog.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import { KNOWN_MODELS } from '../../../core/providers/known-models.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { CLI_TOOL_IDS, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { ConfiguredProviderRuntime } from '../../detection/provider-outcomes.js';
import type { ScopedCliCatalogRuntime } from '../../detection/cli-catalog-outcomes.js';
import { getModelsForProvider } from '../models-dev.js';
import { areExactModelSelectionIdsEqual } from './parsing.js';
import { includes } from '../../../utils/type-guards.js';

export interface RuntimeMembershipAccess {
  readonly runnerCredentialDomain: CredentialDomainIdentity | undefined;
  readonly sourceCredentialDomain: CredentialDomainIdentity | undefined;
}

export interface ModelCacheAccessor {
  getModelsDevCatalog(): ModelsDevCatalog | null;
  getProviderModels(providerId: ProviderId): readonly DetectedModel[] | null;
  /** Staleness of the generic memory backing getProviderModels (remembered rows). */
  isProviderModelCacheStale?(providerId: ProviderId): boolean;
  /**
   * Current role-scoped API membership. When present, this is authoritative
   * for API and Agent SDK model lookup and prevents ambiguous generic reuse.
   */
  getScopedProviderRuntime?(
    input: Readonly<{ role: ActiveRunnerRole; provider: ApiProviderId }>,
  ): ConfiguredProviderRuntime | null | undefined;
  /** Exact role/tool/context CLI membership; null is authoritative absence. */
  getScopedCliCatalogRuntime?(
    input: Readonly<{ role: ActiveRunnerRole; tool: CliToolId }>,
  ): ScopedCliCatalogRuntime | null | undefined;
  getRuntimeMembershipAccess?(
    input: Readonly<{ runnerId: ProviderId; sourceProviderId: ProviderId }>,
  ): RuntimeMembershipAccess | null;
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

interface ModelsDevCatalogSource {
  readonly provider: ProviderId;
  readonly include?: (modelId: string) => boolean;
}

const OPENAI_TOOL_MODEL_RE = /^(gpt-|o\d|codex)/i;
const OPENAI_NON_TOOL_MODEL_RE =
  /^(text-embedding|gpt-image|whisper|tts-|omni-moderation|text-moderation|dall-e)/i;
const CLAUDE_CODE_MODEL_RE = /^claude-(sonnet|opus)-/i;
const ANTHROPIC_MODEL_RE = /^claude-/i;

const TOOL_MODELS_DEV_SOURCES: Partial<Record<ProviderId, readonly ModelsDevCatalogSource[]>> = {
  'claude-code': [
    { provider: 'anthropic', include: (modelId) => CLAUDE_CODE_MODEL_RE.test(modelId) },
  ],
  codex: [
    {
      provider: 'openai',
      include: (modelId) =>
        OPENAI_TOOL_MODEL_RE.test(modelId) && !OPENAI_NON_TOOL_MODEL_RE.test(modelId),
    },
  ],
  aider: [
    { provider: 'anthropic', include: (modelId) => ANTHROPIC_MODEL_RE.test(modelId) },
    {
      provider: 'openai',
      include: (modelId) =>
        OPENAI_TOOL_MODEL_RE.test(modelId) && !OPENAI_NON_TOOL_MODEL_RE.test(modelId),
    },
  ],
  copilot: [{ provider: 'copilot' }],
  opencode: [{ provider: 'opencode' }],
  'kilo-code': [{ provider: 'kilo-code' }],
  'agent-sdk': [{ provider: 'anthropic', include: (modelId) => ANTHROPIC_MODEL_RE.test(modelId) }],
};

function getModelsDevSources(providerId: ProviderId): readonly ModelsDevCatalogSource[] {
  return TOOL_MODELS_DEV_SOURCES[providerId] ?? [{ provider: providerId }];
}

function exactLookup(
  input: Readonly<{
    entries: readonly DetectedModel[];
    selectionId: string;
    sourceProviderId?: string | undefined;
  }>,
): ExactModelLookup {
  const matches = input.entries.filter(
    (entry) =>
      areExactModelSelectionIdsEqual({ left: entry.id, right: input.selectionId }) &&
      (input.sourceProviderId === undefined || entry.providerId === input.sourceProviderId),
  );
  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length === 1) {
    const [model] = matches;
    if (model !== undefined) return { kind: 'found', model };
  }
  return { kind: 'ambiguous', models: matches };
}

function agentSdkCanReuseAnthropicMembership(cache: ModelCacheAccessor): boolean {
  const access = cache.getRuntimeMembershipAccess?.({
    runnerId: 'agent-sdk',
    sourceProviderId: 'anthropic',
  });
  return (
    access !== null &&
    access !== undefined &&
    isSameCredentialDomain({
      left: access.runnerCredentialDomain,
      right: access.sourceCredentialDomain,
    })
  );
}

export function getBundledModels(providerId: ProviderId): readonly KnownModel[] {
  return KNOWN_MODELS[providerId] ?? [];
}

export function getRuntimeLookupProvider(
  providerId: ProviderId,
  cache: ModelCacheAccessor = NULL_CACHE,
): ProviderId | null {
  if (providerId !== 'agent-sdk') return providerId;
  return agentSdkCanReuseAnthropicMembership(cache) ? 'anthropic' : null;
}

function scopedRuntimeProvider(providerId: ProviderId): ApiProviderId | null {
  if (providerId === 'agent-sdk') return 'anthropic';
  return isApiProviderId(providerId) ? providerId : null;
}

function scopedCliTool(providerId: ProviderId): CliToolId | null {
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
  }>,
): RuntimeModelSnapshot | undefined {
  if (input.role === undefined) return undefined;
  const cliTool = scopedCliTool(input.providerId);
  if (cliTool !== null && input.cache.getScopedCliCatalogRuntime !== undefined) {
    const runtime = input.cache.getScopedCliCatalogRuntime({ role: input.role, tool: cliTool });
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
  }>,
): RuntimeModelSnapshot | null {
  const scoped = getScopedRuntimeSnapshot(input);
  if (scoped !== undefined) return scoped;
  const runtimeProviderId = getRuntimeLookupProvider(input.providerId, input.cache);
  if (runtimeProviderId === null) return null;
  const entries = input.cache.getProviderModels(runtimeProviderId);
  if (entries === null) return null;
  return {
    providerId: runtimeProviderId,
    entries,
    isStale: input.cache.isProviderModelCacheStale?.(runtimeProviderId) ?? false,
  };
}

export function getModelsDevEntries(
  providerId: ProviderId,
  cache: ModelCacheAccessor,
): DetectedModel[] {
  const catalog = cache.getModelsDevCatalog();
  if (!catalog) return [];

  const entries = new Map<string, DetectedModel>();
  for (const source of getModelsDevSources(providerId)) {
    for (const entry of getModelsForProvider(catalog, source.provider)) {
      if (source.include !== undefined && !source.include(entry.id)) continue;
      const owner = entry.providerId ?? source.provider;
      entries.set(`${owner}\u0000${entry.id}`, entry);
    }
  }
  return [...entries.values()];
}

export function resolveExactModelsDevModel(
  input: Readonly<{
    providerId: ProviderId;
    selectionId: string;
    cache: ModelCacheAccessor;
    sourceProviderId?: string | undefined;
  }>,
): ExactModelLookup {
  return exactLookup({
    entries: getModelsDevEntries(input.providerId, input.cache),
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

export function lookupModelsDevModel(
  providerId: ProviderId,
  modelId: string,
  cache: ModelCacheAccessor,
): DetectedModel | null {
  const outcome = resolveExactModelsDevModel({
    providerId,
    selectionId: modelId,
    cache,
  });
  return outcome.kind === 'found' ? outcome.model : null;
}

export function lookupRuntimeModel(
  providerId: ProviderId,
  modelId: string,
  cache: ModelCacheAccessor,
): DetectedModel | null {
  const outcome = resolveExactRuntimeModel({
    providerId,
    selectionId: modelId,
    cache,
  });
  return outcome.kind === 'found' ? outcome.model : null;
}

function mergeExactMetadata(
  runtime: DetectedModel,
  modelsDev: DetectedModel | null,
): DetectedModel {
  if (modelsDev === null) return runtime;
  return { ...modelsDev, ...runtime };
}

interface ModelMetadataLookupInput {
  readonly providerId: ProviderId;
  readonly selectionId: string;
  readonly cache: ModelCacheAccessor;
  readonly sourceProviderId?: string | undefined;
  readonly role?: ActiveRunnerRole | undefined;
}

export function findModelMetadata(input: ModelMetadataLookupInput): DetectedModel | null;
export function findModelMetadata(
  providerId: ProviderId,
  selectionId: string,
  cache: ModelCacheAccessor,
): DetectedModel | null;
export function findModelMetadata(
  inputOrProviderId: ModelMetadataLookupInput | ProviderId,
  legacySelectionId?: string,
  legacyCache?: ModelCacheAccessor,
): DetectedModel | null {
  const input: ModelMetadataLookupInput =
    typeof inputOrProviderId === 'string'
      ? {
          providerId: inputOrProviderId,
          selectionId: legacySelectionId ?? '',
          cache: legacyCache ?? NULL_CACHE,
        }
      : inputOrProviderId;
  const runtime = resolveExactRuntimeModel(input);
  const modelsDev = resolveExactModelsDevModel(input);

  if (runtime.kind !== 'found') return modelsDev.kind === 'found' ? modelsDev.model : null;
  return mergeExactMetadata(runtime.model, modelsDev.kind === 'found' ? modelsDev.model : null);
}

export function findKnownModel(providerId: ProviderId, modelId: string): KnownModel | undefined {
  return getBundledModels(providerId).find(
    (entry) =>
      areExactModelSelectionIdsEqual({ left: entry.name, right: modelId }) ||
      entry.aliases?.some((alias) =>
        areExactModelSelectionIdsEqual({ left: alias, right: modelId }),
      ) ||
      (entry.catalogModelId !== undefined &&
        areExactModelSelectionIdsEqual({ left: entry.catalogModelId, right: modelId })),
  );
}

function getDefaultKnownModel(providerId: ProviderId): KnownModel | undefined {
  return getBundledModels(providerId).find((entry) => entry.isDefault);
}

function isAutomaticSelection(modelId: string | undefined): boolean {
  return modelId === AUTOMATIC_MODEL;
}

export function getEffectiveModelId(providerId: ProviderId, modelId?: string): string | undefined {
  if (modelId !== undefined && modelId.trim() !== '' && !isAutomaticSelection(modelId)) {
    return modelId;
  }

  const fallback = getDefaultKnownModel(providerId);
  return fallback?.catalogModelId ?? fallback?.name;
}
