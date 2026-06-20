import type { DetectedModel, DetectedPricingTier } from '../../core/discovery/detection.js';
import type { ProviderId } from '../../core/schemas/enums.js';
import {
  ModelsDevCatalogSchema,
  type ModelsDevCatalog,
  type ModelsDevModel,
} from '../../core/schemas/models-dev.js';
import { fetchJsonWithTimeout } from './client.js';
import { isModelFree, pricingFieldsFromResolved } from './metadata.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_TIMEOUT_MS = 10_000;
const CONTEXT_OVER_200K_THRESHOLD = 200_000;
type ModelsDevRawCostTier = NonNullable<NonNullable<ModelsDevModel['cost']>['tiers']>[number];

const PROVIDER_TO_MODELS_DEV_IDS: Partial<Record<ProviderId, string[]>> = {
  together: ['togetherai'],
  'lm-studio': ['lmstudio'],
  copilot: ['github-copilot'],
  'kilo-code': ['kilo'],
  opencode: ['opencode', 'opencode-go'],
};

function toModelsDevProviderIds(providerId: ProviderId): string[] {
  return PROVIDER_TO_MODELS_DEV_IDS[providerId] ?? [providerId];
}

function pickFreshestDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
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

function modelToDetected(model: ModelsDevModel): DetectedModel {
  const inputRaw = model.cost?.input;
  const outputRaw = model.cost?.output;
  const hasPricingData = inputRaw !== undefined || outputRaw !== undefined;
  const isFree = hasPricingData ? isModelFree(inputRaw, outputRaw) : undefined;

  const result: DetectedModel = {
    id: model.id,
    ...pricingFieldsFromResolved(inputRaw, outputRaw, isFree),
  };

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
  }

  if (model.limit?.output !== undefined) {
    result.maxOutputTokens = model.limit.output;
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

  const releaseDate = pickFreshestDate(model.release_date, model.last_updated);
  if (releaseDate) result.releaseDate = releaseDate;

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
  const releaseDate = incoming.releaseDate ?? current.releaseDate;
  const capabilities = incoming.capabilities ?? current.capabilities;
  return {
    ...current,
    ...incoming,
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
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

export async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog> {
  const json = await fetchJsonWithTimeout(MODELS_DEV_URL, MODELS_DEV_TIMEOUT_MS);
  const parsed = ModelsDevCatalogSchema.safeParse(json);
  if (!parsed.success) return {};
  return parsed.data;
}

export function getModelsForProvider(
  catalog: ModelsDevCatalog,
  providerId: ProviderId,
): DetectedModel[] {
  const merged = new Map<string, DetectedModel>();

  for (const modelsDevId of toModelsDevProviderIds(providerId)) {
    const provider = catalog[modelsDevId];
    if (!provider?.models) continue;

    for (const model of Object.values(provider.models).map(modelToDetected)) {
      merged.set(model.id, mergeDetectedModel(merged.get(model.id), model));
    }
  }

  return [...merged.values()];
}
