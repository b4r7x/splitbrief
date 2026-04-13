import { z } from 'zod';
import type { DetectedModel } from './types.js';
import type { ProviderId } from '../../core/providers.js';
import { perTokenToPerMillion } from './metadata.js';

const ModelsDevModelSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  cost: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
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

const PROVIDER_ID_MAP: Record<string, string> = {
  togetherai: 'together',
  lmstudio: 'lm-studio',
  'github-copilot': 'copilot',
  kilo: 'kilo-code',
  'opencode-go': 'opencode',
};

function toModelsDevProviderId(providerId: ProviderId): string {
  const reverse = Object.entries(PROVIDER_ID_MAP).find(([, v]) => v === providerId);
  return reverse ? reverse[0] : providerId;
}

function modelToDetected(model: ModelsDevModel): DetectedModel {
  const inputRaw = model.cost?.input;
  const outputRaw = model.cost?.output;
  const pricingInput = inputRaw !== undefined ? perTokenToPerMillion(inputRaw) : 0;
  const pricingOutput = outputRaw !== undefined ? perTokenToPerMillion(outputRaw) : 0;
  const isFree = pricingInput === 0 && pricingOutput === 0;

  const result: DetectedModel = {
    id: model.id,
    pricingInput,
    pricingOutput,
    isFree,
  };

  if (model.limit?.context !== undefined) {
    result.contextLength = model.limit.context;
  }

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
  const modelsDevId = toModelsDevProviderId(providerId);
  const provider = catalog[modelsDevId];
  if (!provider?.models) return [];
  return Object.values(provider.models).map(modelToDetected);
}
