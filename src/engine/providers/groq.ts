import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import type { DetectedModel } from '../../core/types/config-options.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { createMetadataProvider } from './client.js';

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
      fallback: (id) => ({ id }),
      toDetected: toDetectedModel,
      contextLength: (m) => m.context_window ?? null,
    },
    overrides,
  );
}
