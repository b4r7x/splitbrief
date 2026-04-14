import OpenAI from 'openai';
import type { DetectedModel, ProviderDef, ProviderOverrides } from './types.js';
import type { Config, ProviderDetection } from '../../types.js';
import { createClientFromProvider } from './client.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatProvider } from './compat.js';
import { PROVIDER_CATALOG, isProviderId, type ProviderId } from '../../core/providers.js';
import { withTimeout } from '../../utils/with-timeout.js';

export const DETECTION_TIMEOUT_MS = 5000;

type ProviderFactory = (overrides?: ProviderOverrides) => ProviderDef;

const BESPOKE_PROVIDERS: Partial<Record<ProviderId, ProviderFactory>> = {
  anthropic: createAnthropicProvider,
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

function getImplementerProvider(config: Config): ProviderDef {
  if (config.implementer.kind !== 'api') throw new Error('Expected api implementer config');
  const impl = config.implementer;
  return getProvider(impl.provider, {
    apiBase: impl.apiBase,
    apiKey: impl.apiKey,
  });
}

export function createClient(config: Config): OpenAI {
  const provider = getImplementerProvider(config);
  if (provider.name === 'anthropic') {
    throw new Error('Anthropic API is not OpenAI-compatible; use the Anthropic streaming path');
  }
  return createClientFromProvider(provider);
}

export async function detectCapabilities(config: Config): Promise<{ contextLength: number }> {
  const envCtx = process.env.TINY_SPEC_CONTEXT_LENGTH;
  const parsed = envCtx ? parseInt(envCtx, 10) : NaN;
  const configCtx = config.implementer.contextLength ?? 8192;
  const fallback = { contextLength: Number.isNaN(parsed) ? configCtx : parsed };

  const provider = getImplementerProvider(config);

  if (provider.detectContextLength) {
    try {
      const ctx = await provider.detectContextLength(config.implementer.model);
      if (ctx) return { contextLength: ctx };
    } catch { /* empty */ }
  }

  return fallback;
}

async function detectOne(name: ProviderId, factory: ProviderFactory): Promise<ProviderDetection> {
  const provider = factory();
  try {
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
  } catch {
    return { provider: name, available: false, isLocal: provider.isLocal };
  }
}

export async function detectAvailableProviders(): Promise<ProviderDetection[]> {
  const results: Promise<ProviderDetection>[] = [];
  for (const [name, factory] of Object.entries(KNOWN_PROVIDERS)) {
    if (!factory) continue;
    if (!isProviderId(name)) continue;
    results.push(detectOne(name, factory));
  }
  return Promise.all(results);
}
