import type { ProviderDef, ProviderDetection, ProviderOverrides } from './types.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { KNOWN_PROVIDER_BASE_URLS } from '../../core/providers/catalog.js';
import { withTimeout } from '../../utils/with-timeout.js';

export const DETECTION_TIMEOUT_MS = 5000;

export const KNOWN_PROVIDERS: Record<string, (overrides?: ProviderOverrides) => ProviderDef> = {
  ollama: createOllamaProvider,
  'lm-studio': createLmStudioProvider,
  deepseek: (overrides?: ProviderOverrides) =>
    createOpenAICompatProvider('deepseek', KNOWN_PROVIDER_BASE_URLS.deepseek, 'DEEPSEEK_API_KEY', false, overrides),
  openrouter: (overrides?: ProviderOverrides) =>
    createOpenAICompatProvider('openrouter', KNOWN_PROVIDER_BASE_URLS.openrouter, 'OPENROUTER_API_KEY', false, overrides),
};

export function getProvider(name: string, overrides?: ProviderOverrides): ProviderDef {
  const factory = KNOWN_PROVIDERS[name];
  if (factory) return factory(overrides);
  const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  return createOpenAICompatProvider(name, overrides?.apiBase ?? '', envKey, false, overrides);
}

export async function detectAvailableProviders(): Promise<ProviderDetection[]> {
  const entries = Object.entries(KNOWN_PROVIDERS);
  return Promise.all(
    entries.map(async ([name, factory]): Promise<ProviderDetection> => {
      const provider = factory();
      try {
        const models = await withTimeout(provider.listModels(), DETECTION_TIMEOUT_MS);
        return {
          provider: name,
          available: models.length > 0,
          models: models.length > 0 ? models : undefined,
          isLocal: provider.isLocal,
          hasKey: !provider.isLocal ? !!provider.apiKey() : undefined,
        };
      } catch {
        return { provider: name, available: false, isLocal: provider.isLocal };
      }
    }),
  );
}
