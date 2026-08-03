import { z } from 'zod';
import type { ProviderDefWithMetadata, ProviderOverrides } from './types.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import { createMetadataProvider } from './client/metadata.js';
import { extractOpenAIModelList, isOpenAIModelList } from './client/request.js';

const GROQ_NON_GENERATIVE_TYPES = new Set([
  'audio',
  'embedding',
  'moderation',
  'rerank',
  'safety',
  'speech',
  'transcription',
  'tts',
]);

const GROQ_NON_GENERATIVE_PREFIXES = [
  'distil-whisper-',
  'llama-guard-',
  'meta-llama/llama-guard-',
  'playai-tts',
  'whisper-',
] as const;

const GroqModelSchema = z.looseObject({
  id: z.string(),
  display_name: z.string().optional(),
  type: z.string().optional(),
  context_window: z.number().int().positive().optional(),
});

type GroqModel = z.infer<typeof GroqModelSchema>;

function isGroqGenerativeModel(model: GroqModel): boolean {
  const id = model.id.trim().toLowerCase();
  const type = model.type?.trim().toLowerCase();
  return (
    !GROQ_NON_GENERATIVE_PREFIXES.some((prefix) => id.startsWith(prefix)) &&
    (type === undefined || !GROQ_NON_GENERATIVE_TYPES.has(type))
  );
}

function extractGroqModels(data: unknown): GroqModel[] | null {
  if (!isOpenAIModelList(data)) return null;
  const candidates = extractOpenAIModelList(data, (model) => GroqModelSchema.safeParse(model));
  return candidates.flatMap((candidate) => {
    if (!candidate.success || !isGroqGenerativeModel(candidate.data)) return [];
    return [candidate.data];
  });
}

function toDetectedModel(m: GroqModel): DetectedModel {
  const result: DetectedModel = {
    id: m.id,
    ...(m.display_name === undefined ? {} : { displayName: m.display_name }),
  };
  if (m.context_window !== undefined) {
    result.contextLength = m.context_window;
  }
  return result;
}

export function createGroqProvider(overrides?: ProviderOverrides): ProviderDefWithMetadata {
  return createMetadataProvider<GroqModel>(
    {
      name: 'groq',
      defaultBaseURL: getKnownProviderBaseURL('groq'),
      envKeyName: 'GROQ_API_KEY',
      isLocal: false,
      schema: GroqModelSchema,
      fallback: (id) => ({ id }),
      toDetected: toDetectedModel,
      contextLength: (m) => m.context_window ?? null,
      extractModels: extractGroqModels,
    },
    overrides,
  );
}
