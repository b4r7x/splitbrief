import type { DetectedModel, ProviderDef, ProviderOverrides } from './types.js';
import type { ProviderDetection } from '../../types.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { PROVIDER_CATALOG, isProviderId, type ProviderId } from '../../core/providers/catalog.js';
import { withTimeout } from '../../utils/with-timeout.js';

export const DETECTION_TIMEOUT_MS = 5000;

type ProviderFactory = (overrides?: ProviderOverrides) => ProviderDef;

const BESPOKE_PROVIDERS: Partial<Record<ProviderId, ProviderFactory>> = {
  ollama: createOllamaProvider,
  'lm-studio': createLmStudioProvider,
  openrouter: createOpenRouterProvider,
  groq: createGroqProvider,
  together: createTogetherProvider,
};

function buildOpenAICompatFactories(): Partial<Record<ProviderId, ProviderFactory>> {
  const out: Partial<Record<ProviderId, ProviderFactory>> = {};
  for (const info of Object.values(PROVIDER_CATALOG)) {
    if (BESPOKE_PROVIDERS[info.id]) continue;
    if (!info.baseURL || !info.apiKeyEnv) continue;
    const { id, baseURL, apiKeyEnv } = info;
    out[id] = (overrides?: ProviderOverrides) =>
      createOpenAICompatProvider(id, baseURL, apiKeyEnv, false, overrides);
  }
  return out;
}

export const KNOWN_PROVIDERS: Partial<Record<ProviderId, ProviderFactory>> = {
  ...BESPOKE_PROVIDERS,
  ...buildOpenAICompatFactories(),
};

export function getProvider(name: string, overrides?: ProviderOverrides): ProviderDef {
  const factory = isProviderId(name) ? KNOWN_PROVIDERS[name] : undefined;
  if (factory) return factory(overrides);
  if (!overrides?.apiBase) {
    throw new Error(`Unknown provider '${name}' requires an apiBase override`);
  }
  const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  return createOpenAICompatProvider(name, overrides.apiBase, envKey, false, overrides);
}

export async function detectAvailableProviders(): Promise<ProviderDetection[]> {
  const entries = Object.entries(KNOWN_PROVIDERS) as Array<[ProviderId, ProviderFactory]>;
  return Promise.all(
    entries.map(async ([name, factory]): Promise<ProviderDetection> => {
      const provider = factory();
      try {
        // Prefer metadata-rich method if available
        let models: DetectedModel[];
        if (provider.listModelsWithMetadata) {
          models = await withTimeout(provider.listModelsWithMetadata(), DETECTION_TIMEOUT_MS);
        } else {
          const ids = await withTimeout(provider.listModels(), DETECTION_TIMEOUT_MS);
          models = ids.map((id) => ({ id }));
        }
        return {
          provider: name,
          available: models.length > 0,
          models: models.length > 0 ? models : undefined,
          isLocal: provider.isLocal,
          hasKey: !provider.isLocal ? !!provider.apiKey() : undefined,
        };
      } catch { /* provider unreachable — mark unavailable */
        return { provider: name, available: false, isLocal: provider.isLocal };
      }
    }),
  );
}
