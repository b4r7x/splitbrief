import { z } from 'zod';
import { resolveDefaultApiBase } from '../../core/providers.js';
import { createProviderShell, fetchModelList, stripV1Suffix } from './client.js';
import type { DetectedModel, ProviderDef, ProviderOverrides } from './types.js';

export const ANTHROPIC_API_VERSION = '2023-06-01';

const DEFAULT_ANTHROPIC_BASE_URL =
  resolveDefaultApiBase('anthropic') ?? 'https://api.anthropic.com/v1';

const AnthropicModelSchema = z.object({
  id: z.string(),
  created_at: z.string().optional(),
});

const AnthropicModelListSchema = z.object({
  data: z.array(AnthropicModelSchema),
});

function buildAnthropicHeaders(apiKey: string): Record<string, string> | undefined {
  if (!apiKey) return undefined;
  return {
    'anthropic-version': ANTHROPIC_API_VERSION,
    'x-api-key': apiKey,
  };
}

function extractAnthropicModels(data: unknown): DetectedModel[] | null {
  const parsed = AnthropicModelListSchema.safeParse(data);
  if (!parsed.success) return null;
  return parsed.data.data.map((model) => ({
    id: model.id,
    ...(model.created_at && { releaseDate: model.created_at }),
  }));
}

export function createAnthropicProvider(overrides?: ProviderOverrides): ProviderDef {
  const baseURL = overrides?.apiBase ?? DEFAULT_ANTHROPIC_BASE_URL;
  const apiKey = () => overrides?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const shell = createProviderShell({ name: 'anthropic', baseURL, isLocal: false });

  async function listModelsWithMetadata(): Promise<DetectedModel[]> {
    const key = apiKey();
    if (!key) return [];

    return fetchModelList({
      endpoint: `${stripV1Suffix(baseURL)}/v1/models`,
      headers: buildAnthropicHeaders(key),
      onError: shell.trackError,
      extractModels: extractAnthropicModels,
    });
  }

  return {
    name: 'anthropic',
    baseURL,
    apiKey,
    isLocal: false,
    getLastError: shell.getLastError,

    async listModels(): Promise<string[]> {
      const models = await listModelsWithMetadata();
      return models.map((model) => model.id);
    },

    listModelsWithMetadata,
  };
}
