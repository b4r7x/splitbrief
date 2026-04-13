import { z } from 'zod';
import type { DetectedModel } from './types.js';
import type { ProviderId } from '../../core/providers.js';
import { isModelFree } from './metadata.js';

const ModelsDevModelSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  cost: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
});

const ModelsDevProviderSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  models: z.record(z.string(), ModelsDevModelSchema),
});

const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);

export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;
export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;

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

export async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`models.dev responded with ${res.status}`);
    const json: unknown = await res.json();
    const parsed = ModelsDevCatalogSchema.safeParse(json);
    if (!parsed.success) return {};
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}

export function getModelsForProvider(catalog: ModelsDevCatalog, providerId: ProviderId): DetectedModel[] {
  const merged = new Map<string, DetectedModel>();

  for (const modelsDevId of toModelsDevProviderIds(providerId)) {
    const provider = catalog[modelsDevId];
    if (!provider?.models) continue;

    for (const model of Object.values(provider.models).map(modelToDetected)) {
      merged.set(model.id, model);
    }
  }

  return [...merged.values()];
}
