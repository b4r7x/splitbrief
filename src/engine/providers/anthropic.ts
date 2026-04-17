import { z } from 'zod';
import { resolveDefaultApiBase } from '../../core/providers/index.js';
import { createMetadataProvider } from './client.js';
import { ANTHROPIC_API_VERSION, v1ModelsUrl } from '../http.js';
import type { DetectedModel, ProviderDefWithMetadata, ProviderOverrides } from './types.js';

const DEFAULT_ANTHROPIC_BASE_URL =
  resolveDefaultApiBase('anthropic') ?? 'https://api.anthropic.com/v1';

const AnthropicModelSchema = z.object({
  id: z.string(),
  created_at: z.string().optional(),
});

const AnthropicModelListSchema = z.object({
  data: z.array(AnthropicModelSchema),
});

type AnthropicModel = z.infer<typeof AnthropicModelSchema>;

function toDetected(m: AnthropicModel): DetectedModel {
  return {
    id: m.id,
    ...(m.created_at && { releaseDate: m.created_at }),
  };
}

function extractModels(data: unknown): AnthropicModel[] | null {
  const parsed = AnthropicModelListSchema.safeParse(data);
  return parsed.success ? parsed.data.data : null;
}

export function createAnthropicProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  return createMetadataProvider<AnthropicModel>(
    {
      name: 'anthropic',
      defaultBaseURL: DEFAULT_ANTHROPIC_BASE_URL,
      envKeyName: 'ANTHROPIC_API_KEY',
      isLocal: false,
      schema: AnthropicModelSchema,
      fallback: (id) => ({ id }),
      toDetected,
      modelsUrl: v1ModelsUrl,
      extractModels,
      headers: (apiKey) => apiKey
        ? { 'anthropic-version': ANTHROPIC_API_VERSION, 'x-api-key': apiKey }
        : {},
    },
    overrides,
  );
}
