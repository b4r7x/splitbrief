import { z } from 'zod';
import type { DetectedModel, ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers.js';
import { createMetadataProvider, DEFAULT_MODEL_FALLBACK } from './client.js';

const GroqModelSchema = z.object({
  id: z.string(),
  context_window: z.number().optional(),
});

type GroqModel = z.infer<typeof GroqModelSchema>;

function toDetectedModel(m: GroqModel): DetectedModel {
  const result: DetectedModel = { id: m.id };
  if (m.context_window !== undefined) {
    result.contextLength = m.context_window;
  }
  return result;
}

export function createGroqProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  return createMetadataProvider<GroqModel>(
    {
      name: 'groq',
      defaultBaseURL: KNOWN_PROVIDER_BASE_URLS.groq,
      envKeyName: 'GROQ_API_KEY',
      isLocal: false,
      schema: GroqModelSchema,
      fallback: DEFAULT_MODEL_FALLBACK,
      toDetected: toDetectedModel,
      contextLength: (m) => m.context_window ?? null,
    },
    overrides,
  );
}
