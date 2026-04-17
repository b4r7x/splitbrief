import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { createMetadataProvider } from './client.js';
import { v1ModelsUrl } from '../http.js';

type CompatModel = { id: string };

export function createOpenAICompatProvider(
  name: string,
  defaultBaseURL: string,
  envKeyName: string,
  isLocal: boolean,
  overrides?: ProviderOverrides,
): ProviderDefWithMetadata {
  return createMetadataProvider<CompatModel>(
    {
      name,
      defaultBaseURL,
      envKeyName,
      isLocal,
      schema: z.object({ id: z.string() }).passthrough(),
      fallback: (id) => ({ id }),
      modelsUrl: v1ModelsUrl,
    },
    overrides,
  );
}
