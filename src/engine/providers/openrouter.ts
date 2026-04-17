import { z } from 'zod';
import type { DetectedModel, ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { createMetadataProvider } from './client.js';
import { stripV1Suffix } from '../http.js';
import { perTokenToPerMillion } from './metadata.js';

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
  return Number.isNaN(val) ? 0 : perTokenToPerMillion(val);
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

function openRouterModelsUrl(baseURL: string): string {
  const base = stripV1Suffix(baseURL).replace(/\/api\/?$/, '');
  return `${base}/api/v1/models`;
}

export function createOpenRouterProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  return createMetadataProvider<OpenRouterModel>(
    {
      name: 'openrouter',
      defaultBaseURL: DEFAULT_BASE,
      envKeyName: 'OPENROUTER_API_KEY',
      isLocal: false,
      schema: OpenRouterModelSchema,
      fallback: (id) => ({ id }),
      toDetected: toDetectedModel,
      contextLength: (m) => m.context_length ?? null,
      modelsUrl: openRouterModelsUrl,
    },
    overrides,
  );
}
