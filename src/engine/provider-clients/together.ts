import { z } from 'zod';
import type { DetectedModel, ProviderDef, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { extractOpenAIModelList, fetchModelList } from './client.js';

const DEFAULT_BASE = KNOWN_PROVIDER_BASE_URLS.together;

const TogetherModelSchema = z.object({
  id: z.string(),
  context_length: z.number().optional(),
  pricing: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
  }).optional(),
});

type TogetherModel = z.infer<typeof TogetherModelSchema>;

function perTokenToPerMillion(perToken: number): number {
  return perToken * 1_000_000;
}

function extractTogetherModels(data: unknown): TogetherModel[] {
  return extractOpenAIModelList(data, (m) => {
    const parsed = TogetherModelSchema.safeParse(m);
    if (!parsed.success) return { id: m.id };
    return parsed.data;
  });
}

export interface TogetherProviderDef extends ProviderDef {
  listModelsWithMetadata(): Promise<DetectedModel[]>;
  detectContextLength(model: string): Promise<number | null>;
}

export function createTogetherProvider(overrides?: ProviderOverrides): TogetherProviderDef {
  const baseURL = overrides?.apiBase || DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey || process.env.TOGETHER_API_KEY || '';

  async function fetchModels(): Promise<TogetherModel[]> {
    const key = apiKey();
    if (!key) return [];
    return fetchModelList(
      `${baseURL}/models`,
      extractTogetherModels,
      { Authorization: `Bearer ${key}` },
    );
  }

  function toDetectedModel(m: TogetherModel): DetectedModel {
    const result: DetectedModel = { id: m.id };
    if (m.context_length !== undefined) result.contextLength = m.context_length;
    if (m.pricing?.input !== undefined) result.pricingInput = perTokenToPerMillion(m.pricing.input);
    if (m.pricing?.output !== undefined) result.pricingOutput = perTokenToPerMillion(m.pricing.output);
    return result;
  }

  return {
    name: 'together',
    baseURL,
    apiKey,
    isLocal: false,

    async listModels(): Promise<string[]> {
      const models = await fetchModels();
      return models.map((m) => m.id);
    },

    async listModelsWithMetadata(): Promise<DetectedModel[]> {
      const models = await fetchModels();
      return models.map(toDetectedModel);
    },

    async detectContextLength(model: string): Promise<number | null> {
      try {
        const models = await fetchModels();
        const entry = models.find((m) => m.id === model);
        return entry?.context_length ?? null;
      } catch {
        return null;
      }
    },
  };
}
