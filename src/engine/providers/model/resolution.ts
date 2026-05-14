import type { DetectedModel } from '../../../core/types/config-options.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import { KNOWN_MODELS } from '../../../core/providers/known-models.js';
import { getModelsForProvider } from '../models-dev.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { idsMatch } from './parsing.js';

export interface ModelCacheAccessor {
  getModelsDevCatalog(): ModelsDevCatalog | null;
  getProviderModels(providerId: ProviderId): DetectedModel[] | null;
}

export const NULL_CACHE: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

interface ModelsDevCatalogSource {
  provider: ProviderId;
  include?: (modelId: string) => boolean;
}

const OPENAI_TOOL_MODEL_RE = /^(gpt-|o\d|codex)/i;
const OPENAI_NON_TOOL_MODEL_RE = /^(text-embedding|gpt-image|whisper|tts-|omni-moderation|text-moderation|dall-e)/i;
const CLAUDE_CODE_MODEL_RE = /^claude-(sonnet|opus)-/i;
const ANTHROPIC_MODEL_RE = /^claude-/i;

const TOOL_MODELS_DEV_SOURCES: Partial<Record<ProviderId, ModelsDevCatalogSource[]>> = {
  'claude-code': [
    { provider: 'anthropic', include: (modelId) => CLAUDE_CODE_MODEL_RE.test(modelId) },
  ],
  codex: [
    {
      provider: 'openai',
      include: (modelId) => OPENAI_TOOL_MODEL_RE.test(modelId) && !OPENAI_NON_TOOL_MODEL_RE.test(modelId),
    },
  ],
  aider: [
    { provider: 'anthropic', include: (modelId) => ANTHROPIC_MODEL_RE.test(modelId) },
    {
      provider: 'openai',
      include: (modelId) => OPENAI_TOOL_MODEL_RE.test(modelId) && !OPENAI_NON_TOOL_MODEL_RE.test(modelId),
    },
  ],
  copilot: [{ provider: 'copilot' }],
  opencode: [{ provider: 'opencode' }],
  'kilo-code': [{ provider: 'kilo-code' }],
  'agent-sdk': [{ provider: 'anthropic', include: (modelId) => ANTHROPIC_MODEL_RE.test(modelId) }],
};

function getModelsDevSources(providerId: ProviderId): ModelsDevCatalogSource[] {
  return TOOL_MODELS_DEV_SOURCES[providerId] ?? [{ provider: providerId }];
}

export function getBundledModels(providerId: ProviderId): KnownModel[] {
  return KNOWN_MODELS[providerId] ?? [];
}

export function getRuntimeLookupProvider(providerId: ProviderId): ProviderId {
  return providerId === 'agent-sdk' ? 'anthropic' : providerId;
}

export function getModelsDevEntries(providerId: ProviderId, cache: ModelCacheAccessor): DetectedModel[] {
  const catalog = cache.getModelsDevCatalog();
  if (!catalog) return [];

  const merged: DetectedModel[] = [];
  for (const source of getModelsDevSources(providerId)) {
    for (const entry of getModelsForProvider(catalog, source.provider)) {
      if (source.include && !source.include(entry.id)) continue;
      const existingIndex = merged.findIndex((candidate) => idsMatch(candidate.id, entry.id));
      if (existingIndex >= 0) {
        merged[existingIndex] = {
          ...merged[existingIndex],
          ...entry,
        };
        continue;
      }
      merged.push(entry);
    }
  }

  return merged;
}

export function lookupModelsDevModel(
  providerId: ProviderId,
  modelId: string,
  cache: ModelCacheAccessor,
): DetectedModel | null {
  return getModelsDevEntries(providerId, cache).find((entry) => idsMatch(entry.id, modelId)) ?? null;
}

export function lookupRuntimeModel(
  providerId: ProviderId,
  modelId: string,
  cache: ModelCacheAccessor,
): DetectedModel | null {
  const runtimeProvider = cache.getProviderModels(getRuntimeLookupProvider(providerId));
  return runtimeProvider?.find((entry) => idsMatch(entry.id, modelId)) ?? null;
}

export function findModelMetadata(
  providerId: ProviderId,
  modelId: string,
  cache: ModelCacheAccessor,
): DetectedModel | null {
  return lookupModelsDevModel(providerId, modelId, cache)
    ?? lookupRuntimeModel(providerId, modelId, cache);
}

export function findKnownModel(providerId: ProviderId, modelId: string): KnownModel | undefined {
  const bundled = getBundledModels(providerId);
  const direct = bundled.find((entry) =>
    idsMatch(entry.name, modelId)
    || entry.aliases?.some((alias) => idsMatch(alias, modelId)));
  if (direct) return direct;
  return bundled.find((entry) => entry.catalogModelId ? idsMatch(entry.catalogModelId, modelId) : false);
}

export function getDefaultKnownModel(providerId: ProviderId): KnownModel | undefined {
  return getBundledModels(providerId).find((entry) => entry.isDefault);
}

export function getEffectiveModelId(providerId: ProviderId, modelId?: string): string | undefined {
  const selected = modelId?.trim();
  if (selected) {
    const known = findKnownModel(providerId, selected);
    return known?.catalogModelId ?? known?.name ?? selected;
  }

  const fallback = getDefaultKnownModel(providerId);
  return fallback?.catalogModelId ?? fallback?.name;
}
