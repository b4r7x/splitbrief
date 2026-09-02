import type { DetectedModel, DetectedPricingTier } from '../../core/discovery/detection.js';
import type { CatalogVendorId } from '../../core/providers/known-models.js';
import type { ProviderId } from '../../core/schemas/enums.js';
import type { ModelsDevCatalog, ModelsDevModel } from '../../core/schemas/models-dev.js';
import {
  modelsDevCatalogFailureError,
  refreshModelsDevCatalogCache,
  type ModelsDevCatalogCacheOptions,
  type ModelsDevCatalogCacheOutcome,
} from './models-dev-cache.js';
import { isModelFree, pricingFieldsFromResolved } from './metadata.js';
import type { ModelVendorIdentity } from './model/parsing.js';

const CONTEXT_OVER_200K_THRESHOLD = 200_000;
type ModelsDevRawCostTier = NonNullable<NonNullable<ModelsDevModel['cost']>['tiers']>[number];

/** A models.dev vendor: the runner id itself, or the lab a runner fronts. */
export type ModelsDevProviderId = ProviderId | CatalogVendorId;

const PROVIDER_TO_MODELS_DEV_IDS: Partial<Record<ModelsDevProviderId, string[]>> = {
  'lm-studio': ['lmstudio'],
  copilot: ['github-copilot'],
  'kilo-code': ['kilo'],
  opencode: ['opencode', 'opencode-go'],
};

function toModelsDevProviderIds(providerId: ModelsDevProviderId): string[] {
  return PROVIDER_TO_MODELS_DEV_IDS[providerId] ?? [providerId];
}

function hasTierPrice(tier: DetectedPricingTier): boolean {
  return (
    tier.inputPer1M !== undefined ||
    tier.outputPer1M !== undefined ||
    tier.cacheReadPer1M !== undefined ||
    tier.cacheWritePer1M !== undefined
  );
}

function rawContextTierToDetected(tier: ModelsDevRawCostTier): DetectedPricingTier | null {
  if (tier.tier?.type !== 'context' || typeof tier.tier.size !== 'number') return null;
  const detected: DetectedPricingTier = {
    type: 'context',
    thresholdTokens: tier.tier.size,
    ...(tier.input !== undefined && { inputPer1M: tier.input }),
    ...(tier.output !== undefined && { outputPer1M: tier.output }),
    ...(tier.cache_read !== undefined && { cacheReadPer1M: tier.cache_read }),
    ...(tier.cache_write !== undefined && { cacheWritePer1M: tier.cache_write }),
  };
  return hasTierPrice(detected) ? detected : null;
}

function legacyContextOver200kToDetected(
  cost: NonNullable<ModelsDevModel['cost']>,
): DetectedPricingTier | null {
  const legacy = cost.context_over_200k;
  if (!legacy) return null;
  const detected: DetectedPricingTier = {
    type: 'context',
    thresholdTokens: CONTEXT_OVER_200K_THRESHOLD,
    ...(legacy.input !== undefined && { inputPer1M: legacy.input }),
    ...(legacy.output !== undefined && { outputPer1M: legacy.output }),
    ...(legacy.cache_read !== undefined && { cacheReadPer1M: legacy.cache_read }),
    ...(legacy.cache_write !== undefined && { cacheWritePer1M: legacy.cache_write }),
  };
  return hasTierPrice(detected) ? detected : null;
}

function modelPricingTiers(model: ModelsDevModel): DetectedPricingTier[] | undefined {
  const cost = model.cost;
  if (!cost) return undefined;

  const tiers = (cost.tiers ?? [])
    .map(rawContextTierToDetected)
    .filter((tier): tier is DetectedPricingTier => tier !== null);

  const legacy = legacyContextOver200kToDetected(cost);
  const hasEquivalentLegacyTier = tiers.some(
    (tier) => tier.type === 'context' && tier.thresholdTokens === CONTEXT_OVER_200K_THRESHOLD,
  );
  if (legacy && !hasEquivalentLegacyTier) tiers.push(legacy);

  if (tiers.length === 0) return undefined;
  return tiers.sort((a, b) => a.thresholdTokens - b.thresholdTokens);
}

function mergePricingTiers(
  current: DetectedPricingTier[] | undefined,
  incoming: DetectedPricingTier[] | undefined,
): DetectedPricingTier[] | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  const byKey = new Map<string, DetectedPricingTier>();
  for (const tier of current) byKey.set(`${tier.type}:${tier.thresholdTokens}`, tier);
  for (const tier of incoming) byKey.set(`${tier.type}:${tier.thresholdTokens}`, tier);
  return [...byKey.values()].sort((a, b) => a.thresholdTokens - b.thresholdTokens);
}

function modelToDetected(providerId: string, model: ModelsDevModel): DetectedModel {
  const inputRaw = model.cost?.input;
  const outputRaw = model.cost?.output;
  const hasPricingData = inputRaw !== undefined || outputRaw !== undefined;
  const isFree = hasPricingData ? isModelFree(inputRaw, outputRaw) : undefined;

  const result: DetectedModel = {
    id: model.id,
    providerId,
    modelId: model.id,
    ...pricingFieldsFromResolved(inputRaw, outputRaw, isFree),
  };

  if (model.name !== undefined) {
    result.displayName = model.name;
  }

  if (model.status !== undefined) {
    result.lifecycle = model.status;
  }

  if (model.cost?.cache_read !== undefined) {
    result.pricingCacheRead = model.cost.cache_read;
  }

  if (model.cost?.cache_write !== undefined) {
    result.pricingCacheWrite = model.cost.cache_write;
  }

  const pricingTiers = modelPricingTiers(model);
  if (pricingTiers !== undefined) {
    result.pricingTiers = pricingTiers;
  }

  if (model.limit?.context !== undefined) {
    result.contextLength = model.limit.context;
    result.maximumContextTokens = model.limit.context;
  }

  if (model.limit?.input !== undefined) {
    result.maximumInputTokens = model.limit.input;
  }

  if (model.limit?.output !== undefined) {
    result.maxOutputTokens = model.limit.output;
    result.maximumOutputTokens = model.limit.output;
  }

  if (model.temperature !== undefined) {
    result.supportsTemperature = model.temperature;
  }

  if (model.reasoning !== undefined) {
    result.supportsReasoning = model.reasoning;
  }

  const imageInput = model.modalities?.input?.includes('image');
  if (imageInput !== undefined) {
    result.supportsImages = imageInput;
  }

  if (model.modalities?.input !== undefined) {
    result.inputModalities = [...model.modalities.input];
  }

  if (model.modalities?.output !== undefined) {
    result.outputModalities = [...model.modalities.output];
  }

  if (model.tool_call !== undefined) {
    result.supportsToolCalls = model.tool_call;
  }

  if (model.structured_output !== undefined) {
    result.supportsStructuredOutput = model.structured_output;
  }

  if (model.release_date !== undefined) {
    result.releaseDate = model.release_date;
  }

  if (model.last_updated !== undefined) {
    result.updatedDate = model.last_updated;
  }

  return result;
}

function mergeDetectedModel(
  current: DetectedModel | undefined,
  incoming: DetectedModel,
): DetectedModel {
  if (!current) return incoming;
  const contextLength = incoming.contextLength ?? current.contextLength;
  const maxOutputTokens = incoming.maxOutputTokens ?? current.maxOutputTokens;
  const pricingInput = incoming.pricingInput ?? current.pricingInput;
  const pricingOutput = incoming.pricingOutput ?? current.pricingOutput;
  const pricingCacheRead = incoming.pricingCacheRead ?? current.pricingCacheRead;
  const pricingCacheWrite = incoming.pricingCacheWrite ?? current.pricingCacheWrite;
  const pricingTiers = mergePricingTiers(current.pricingTiers, incoming.pricingTiers);
  const isFree = incoming.isFree ?? current.isFree;
  const supportsTemperature = incoming.supportsTemperature ?? current.supportsTemperature;
  const supportsReasoning = incoming.supportsReasoning ?? current.supportsReasoning;
  const supportsImages = incoming.supportsImages ?? current.supportsImages;
  const providerId = incoming.providerId ?? current.providerId;
  const modelId = incoming.modelId ?? current.modelId;
  const displayName = incoming.displayName ?? current.displayName;
  const lifecycle = incoming.lifecycle ?? current.lifecycle;
  const releaseDate = incoming.releaseDate ?? current.releaseDate;
  const updatedDate = incoming.updatedDate ?? current.updatedDate;
  const maximumContextTokens = incoming.maximumContextTokens ?? current.maximumContextTokens;
  const effectiveContextTokens = incoming.effectiveContextTokens ?? current.effectiveContextTokens;
  const maximumInputTokens = incoming.maximumInputTokens ?? current.maximumInputTokens;
  const maximumOutputTokens = incoming.maximumOutputTokens ?? current.maximumOutputTokens;
  const inputModalities = incoming.inputModalities ?? current.inputModalities;
  const outputModalities = incoming.outputModalities ?? current.outputModalities;
  const supportsToolCalls = incoming.supportsToolCalls ?? current.supportsToolCalls;
  const supportsStructuredOutput =
    incoming.supportsStructuredOutput ?? current.supportsStructuredOutput;
  const capabilities = incoming.capabilities ?? current.capabilities;
  return {
    ...current,
    ...incoming,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...pricingFieldsFromResolved(pricingInput, pricingOutput, isFree),
    ...(pricingCacheRead !== undefined ? { pricingCacheRead } : {}),
    ...(pricingCacheWrite !== undefined ? { pricingCacheWrite } : {}),
    ...(pricingTiers !== undefined ? { pricingTiers } : {}),
    ...(supportsTemperature !== undefined ? { supportsTemperature } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(supportsImages !== undefined ? { supportsImages } : {}),
    ...(releaseDate !== undefined ? { releaseDate } : {}),
    ...(updatedDate !== undefined ? { updatedDate } : {}),
    ...(maximumContextTokens !== undefined ? { maximumContextTokens } : {}),
    ...(effectiveContextTokens !== undefined ? { effectiveContextTokens } : {}),
    ...(maximumInputTokens !== undefined ? { maximumInputTokens } : {}),
    ...(maximumOutputTokens !== undefined ? { maximumOutputTokens } : {}),
    ...(inputModalities !== undefined ? { inputModalities: [...inputModalities] } : {}),
    ...(outputModalities !== undefined ? { outputModalities: [...outputModalities] } : {}),
    ...(supportsToolCalls !== undefined ? { supportsToolCalls } : {}),
    ...(supportsStructuredOutput !== undefined ? { supportsStructuredOutput } : {}),
    ...(capabilities !== undefined ? { capabilities: [...capabilities] } : {}),
  };
}

export async function fetchModelsDevCatalogWithCache(
  options: ModelsDevCatalogCacheOptions = {},
): Promise<ModelsDevCatalogCacheOutcome> {
  return refreshModelsDevCatalogCache(options);
}

export async function fetchModelsDevCatalog(
  options: ModelsDevCatalogCacheOptions = {},
): Promise<ModelsDevCatalog> {
  const outcome = await fetchModelsDevCatalogWithCache(options);
  switch (outcome.kind) {
    case 'cached':
    case 'fresh':
    case 'not-modified':
    case 'stale':
      return outcome.snapshot.catalog;
    case 'failed':
      throw modelsDevCatalogFailureError(outcome.failure);
  }
}

/**
 * Model-keyed catalog lookup for a runner that has no catalog vendor of its own
 * — a custom endpoint. A `vendor/model` prefix narrows the search to that
 * vendor; a bare id searches every vendor and prefers a row that carries a rate.
 */
export function findCatalogModelByIdentity(
  catalog: ModelsDevCatalog,
  identity: ModelVendorIdentity,
): DetectedModel | null {
  let unpriced: DetectedModel | null = null;
  for (const [key, provider] of Object.entries(catalog)) {
    if (identity.vendor !== undefined && key !== identity.vendor && provider.id !== identity.vendor)
      continue;
    for (const model of Object.values(provider.models)) {
      if (model.id !== identity.bareId) continue;
      const detected = modelToDetected(provider.id, model);
      if (detected.pricingInput !== undefined && detected.pricingOutput !== undefined) {
        return detected;
      }
      unpriced ??= detected;
    }
  }
  return unpriced;
}

export function getModelsForProvider(
  catalog: ModelsDevCatalog,
  providerId: ModelsDevProviderId,
): DetectedModel[] {
  const merged = new Map<string, DetectedModel>();

  for (const modelsDevId of toModelsDevProviderIds(providerId)) {
    const provider = catalog[modelsDevId];
    if (!provider?.models) continue;

    for (const model of Object.values(provider.models)) {
      const detected = modelToDetected(provider.id, model);
      const identity = `${provider.id}\u0000${model.id}`;
      merged.set(identity, mergeDetectedModel(merged.get(identity), detected));
    }
  }

  return [...merged.values()];
}
