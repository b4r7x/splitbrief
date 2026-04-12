import { z } from 'zod';
import type { DetectedModel, ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers.js';
import { createMetadataProvider } from './client.js';
import { perTokenToPerMillion } from './metadata.js';

const TogetherModelSchema = z.object({
  id: z.string(),
  context_length: z.number().optional(),
  pricing: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
  }).optional(),
});

type TogetherModel = z.infer<typeof TogetherModelSchema>;

function toDetectedModel(m: TogetherModel): DetectedModel {
  const result: DetectedModel = { id: m.id };
  if (m.context_length !== undefined) result.contextLength = m.context_length;
  if (m.pricing?.input !== undefined) result.pricingInput = perTokenToPerMillion(m.pricing.input);
  if (m.pricing?.output !== undefined) result.pricingOutput = perTokenToPerMillion(m.pricing.output);
  return result;
}

export function createTogetherProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  return createMetadataProvider<TogetherModel>(
    {
      name: 'together',
      defaultBaseURL: KNOWN_PROVIDER_BASE_URLS.together,
      envKeyName: 'TOGETHER_API_KEY',
      isLocal: false,
      schema: TogetherModelSchema,
      fallback: (id) => ({ id }),
      toDetected: toDetectedModel,
      contextLength: (m) => m.context_length ?? null,
    },
    overrides,
  );
}
