import { z } from 'zod';
import type { ProviderDef, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/index.js';
import { createMetadataProvider } from './client.js';

const LmStudioModelSchema = z.object({
  id: z.string(),
  max_context_length: z.number().optional(),
});

type LmStudioModel = z.infer<typeof LmStudioModelSchema>;

export function createLmStudioProvider(overrides?: ProviderOverrides): ProviderDef {
  return createMetadataProvider<LmStudioModel>(
    {
      name: 'lm-studio',
      defaultBaseURL: KNOWN_PROVIDER_BASE_URLS['lm-studio'],
      envKeyName: '',
      apiKeyDefault: 'lm-studio',
      isLocal: true,
      schema: LmStudioModelSchema,
      fallback: (id) => ({ id }),
      contextLength: (m) => m.max_context_length ?? null,
    },
    overrides,
  );
}
