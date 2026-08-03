import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import { createMetadataProvider } from './client/metadata.js';
import { v1ModelsUrl } from './constants.js';
import { extractOpenAIModelList, isOpenAIModelList } from './client/request.js';

const CompatModelSchema = z.looseObject({ id: z.string() });

type CompatModel = z.infer<typeof CompatModelSchema>;

const OPENAI_NON_GENERATIVE_PREFIXES = [
  'chatgpt-image-',
  'dall-e-',
  'gpt-4o-audio-',
  'gpt-4o-mini-audio-',
  'gpt-audio-',
  'gpt-image-',
  'omni-moderation-',
  'sora-',
  'text-embedding-',
  'text-moderation-',
  'tts-',
  'whisper-',
] as const;

const OPENAI_NON_GENERATIVE_IDS = new Set([
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-tts',
  'gpt-4o-transcribe',
]);

const DEEPSEEK_NON_GENERATIVE_PREFIXES = [
  'deepseek-embedding',
  'deepseek-rerank',
  'deepseek-reranker',
] as const;

function hasKnownPrefix(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => id.startsWith(prefix));
}

function isAdmittedOpenAICompatModel(input: Readonly<{ provider: string; id: string }>): boolean {
  const id = input.id.trim().toLowerCase();
  switch (input.provider.trim().toLowerCase()) {
    case 'openai':
      return (
        !OPENAI_NON_GENERATIVE_IDS.has(id) && !hasKnownPrefix(id, OPENAI_NON_GENERATIVE_PREFIXES)
      );
    case 'deepseek':
      return !hasKnownPrefix(id, DEEPSEEK_NON_GENERATIVE_PREFIXES);
    default:
      return true;
  }
}

function extractOpenAICompatModels(
  input: Readonly<{ provider: string; data: unknown }>,
): CompatModel[] | null {
  if (!isOpenAIModelList(input.data)) return null;
  return extractOpenAIModelList(input.data, (model) => ({ id: model.id })).filter((model) =>
    isAdmittedOpenAICompatModel({ provider: input.provider, id: model.id }),
  );
}

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
      schema: CompatModelSchema,
      fallback: (id) => ({ id }),
      modelsUrl: v1ModelsUrl,
      extractModels: (data) => extractOpenAICompatModels({ provider: opts.name, data }),
    },
    opts.overrides,
  );
}
