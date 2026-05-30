import type { DetectedModel } from '../../core/types/config-options.js';
import type { ProviderId } from '../../core/schemas/enums.js';
import {
  ModelsDevCatalogSchema,
  type ModelsDevCatalog,
  type ModelsDevModel,
} from '../../core/schemas/models-dev.js';
import { fetchJsonWithTimeout } from './client.js';
import { isModelFree, pricingFieldsFromResolved } from './metadata.js';

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
  const isFree = hasPricingData ? isModelFree(inputRaw, outputRaw) : undefined;

  const result: DetectedModel = {
    id: model.id,
    ...pricingFieldsFromResolved(inputRaw, outputRaw, isFree),
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
    ...pricingFieldsFromResolved(pricingInput, pricingOutput, isFree),
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
