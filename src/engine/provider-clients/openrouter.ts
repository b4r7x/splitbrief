import { z } from 'zod';
import type { DetectedModel, ProviderDef, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { extractOpenAIModelList, fetchModelList, stripV1Suffix } from './client.js';

const DEFAULT_BASE = KNOWN_PROVIDER_BASE_URLS.openrouter;

const OpenRouterModelSchema = z.object({
  id: z.string(),
  context_length: z.number().optional(),
  pricing: z
    .object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
    })
    .optional(),
  architecture: z
    .object({
      modality: z
        .object({
          input: z.array(z.string()).optional(),
          output: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

export function parsePrice(str: string | undefined): number {
  if (!str) return 0;
  const val = parseFloat(str);
  return Number.isNaN(val) ? 0 : val * 1_000_000;
}

export function toDetectedModel(m: OpenRouterModel): DetectedModel {
  const inputPrice = parsePrice(m.pricing?.prompt);
  const outputPrice = parsePrice(m.pricing?.completion);
  const isFree = m.id.endsWith(':free') || (inputPrice === 0 && outputPrice === 0);

  const capabilities: string[] = [];
  if (m.architecture?.modality?.input?.includes('image')) capabilities.push('vision');

  const result: DetectedModel = {
    id: m.id,
    pricingInput: inputPrice,
    pricingOutput: outputPrice,
    isFree,
  };

  if (m.context_length !== undefined) {
    result.contextLength = m.context_length;
  }
  if (capabilities.length > 0) {
    result.capabilities = capabilities;
  }

  return result;
}

function extractOpenRouterModels(data: unknown): OpenRouterModel[] {
  return extractOpenAIModelList(data, (m) => {
    const parsed = OpenRouterModelSchema.safeParse(m);
    if (!parsed.success) return { id: m.id };
    return parsed.data;
  });
}

export interface OpenRouterProviderDef extends ProviderDef {
  listModelsWithMetadata(): Promise<DetectedModel[]>;
  detectContextLength(model: string): Promise<number | null>;
}

export function createOpenRouterProvider(overrides?: ProviderOverrides): OpenRouterProviderDef {
  const baseURL = overrides?.apiBase || DEFAULT_BASE;
  const apiKey = () => overrides?.apiKey || process.env.OPENROUTER_API_KEY || '';

  function getModelsUrl(): string {
    const base = stripV1Suffix(baseURL).replace(/\/api\/?$/, '');
    return `${base}/api/v1/models`;
  }

  async function fetchModels(): Promise<OpenRouterModel[]> {
    const key = apiKey();
    if (!key) return [];
    return fetchModelList(
      getModelsUrl(),
      extractOpenRouterModels,
      { Authorization: `Bearer ${key}` },
    );
  }

  return {
    name: 'openrouter',
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
      const models = await fetchModels();
      const found = models.find((m) => m.id === model);
      return found?.context_length ?? null;
    },
  };
}
