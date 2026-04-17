import { z } from 'zod';
import type { DetectedModel } from '../../core/types/config-options.js';
import type { ProviderId } from '../../core/types/schemas/enums.js';
import type { ModelsDevCatalog, ModelsDevModel } from '../../core/types/model-catalog.js';
import { fetchJsonWithTimeout } from './client.js';
import { isModelFree } from './metadata.js';

export type { ModelsDevCatalog } from '../../core/types/model-catalog.js';

const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cost: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
});

const ModelsDevProviderSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  models: z.record(z.string(), ModelsDevModelSchema),
});

const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);

const MODELS_DEV_URL = 'https://models.dev/api.json';

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

function modelToDetected(model: ModelsDevModel): DetectedModel {
  const inputRaw = model.cost?.input;
  const outputRaw = model.cost?.output;
  const hasPricingData = inputRaw !== undefined || outputRaw !== undefined;
  const pricingInput = inputRaw;
  const pricingOutput = outputRaw;
  const isFree = hasPricingData ? isModelFree(pricingInput, pricingOutput) : undefined;

  const result: DetectedModel = {
    id: model.id,
    ...(pricingInput !== undefined && { pricingInput }),
    ...(pricingOutput !== undefined && { pricingOutput }),
    ...(isFree !== undefined && { isFree }),
  };

  if (model.limit?.context !== undefined) {
    result.contextLength = model.limit.context;
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
  const pricingInput = incoming.pricingInput ?? current.pricingInput;
  const pricingOutput = incoming.pricingOutput ?? current.pricingOutput;
  const isFree = incoming.isFree ?? current.isFree;
  const releaseDate = incoming.releaseDate ?? current.releaseDate;
  const capabilities = incoming.capabilities ?? current.capabilities;
  return {
    ...current,
    ...incoming,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(pricingInput !== undefined ? { pricingInput } : {}),
    ...(pricingOutput !== undefined ? { pricingOutput } : {}),
    ...(isFree !== undefined ? { isFree } : {}),
    ...(releaseDate !== undefined ? { releaseDate } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

export async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog> {
  const json = await fetchJsonWithTimeout(MODELS_DEV_URL, 10_000);
  const parsed = ModelsDevCatalogSchema.safeParse(json);
  if (!parsed.success) return {};
  return parsed.data;
}

export function getModelsForProvider(catalog: ModelsDevCatalog, providerId: ProviderId): DetectedModel[] {
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
