import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import type { DetectedModel } from '../../core/types/config-options.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { createMetadataProvider } from './client.js';
import { stripV1Suffix } from './constants.js';
import { perTokenToPerMillion, pricingFieldsFromResolved } from './metadata.js';

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

export function parsePrice(str: string | undefined): number | undefined {
  if (str === undefined) return undefined;
  const trimmed = str.trim();
  if (trimmed === '') return undefined;
  const val = Number(trimmed);
  return Number.isFinite(val) ? perTokenToPerMillion(val) : undefined;
}

export function toDetectedModel(m: OpenRouterModel): DetectedModel {
  const inputPrice = parsePrice(m.pricing?.prompt);
  const outputPrice = parsePrice(m.pricing?.completion);
  const hasCompletePricing = inputPrice !== undefined && outputPrice !== undefined;
  const isFree =
    m.id.endsWith(':free') ||
    (hasCompletePricing ? inputPrice === 0 && outputPrice === 0 : undefined);

  const capabilities: string[] = [];
  if (m.architecture?.modality?.input?.includes('image')) capabilities.push('vision');

  const result: DetectedModel = {
    id: m.id,
    ...pricingFieldsFromResolved(inputPrice, outputPrice, isFree),
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
