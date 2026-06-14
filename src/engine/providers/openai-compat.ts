import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { createMetadataProvider } from './client.js';
import { v1ModelsUrl } from './constants.js';

type CompatModel = { id: string };

export function createOpenAICompatProvider(opts: {
  name: string;
  defaultBaseURL: string;
  envKeyName: string;
  overrides?: ProviderOverrides | undefined;
}): ProviderDefWithMetadata {
  return createMetadataProvider<CompatModel>(
    {
      name: opts.name,
      defaultBaseURL: opts.defaultBaseURL,
      envKeyName: opts.envKeyName,
      isLocal: false,
      schema: z.looseObject({ id: z.string() }),
      fallback: (id) => ({ id }),
      modelsUrl: v1ModelsUrl,
    },
    opts.overrides,
  );
}
