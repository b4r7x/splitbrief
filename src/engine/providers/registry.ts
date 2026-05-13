import type OpenAI from 'openai';
import type { DetectedModel, ProviderDef, ProviderOverrides } from './types.js';
import type { Config } from '../../core/schemas/config.js';
import type { ProviderDetection } from '../../core/types/config-options.js';
import { createClientFromProvider } from './client.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createAnthropicProvider } from './anthropic/adapter.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { PROVIDER_CATALOG } from '../../core/providers/catalog.js';
import { isProviderId, type ProviderId } from '../../core/schemas/enums.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { providerError } from './errors.js';

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
  if (!overrides?.apiBase) throw providerError.unknownNeedsApiBase(name);
  if (!overrides.apiKey) throw providerError.unknownNeedsApiKey(name);
  return createOpenAICompatProvider(name, overrides.apiBase, '', false, overrides);
}

function getImplementerProvider(config: Config): ProviderDef {
  const impl = config.implementer;
  if (impl.kind !== 'api') throw providerError.notApi(impl.kind);
  return getProvider(impl.provider, {
    apiBase: impl.apiBase,
    apiKey: impl.apiKey,
  });
}

export function createClient(config: Config): OpenAI {
  const provider = getImplementerProvider(config);
  if (provider.name === 'anthropic') throw providerError.anthropicNotOpenAICompat();
  return createClientFromProvider(provider);
}

export async function detectCapabilities(config: Config): Promise<{ contextLength: number }> {
  const envCtx = process.env.DIPTYCH_CONTEXT_LENGTH;
  const parsed = envCtx ? parseInt(envCtx, 10) : NaN;
  const configCtx = config.implementer.contextLength ?? 8192;
  const fallback = { contextLength: Number.isNaN(parsed) ? configCtx : parsed };

  if (config.implementer.kind !== 'api') return fallback;

  const provider = getImplementerProvider(config);

  if (provider.detectContextLength) {
    try {
      const ctx = await provider.detectContextLength(config.implementer.model);
      if (ctx) return { contextLength: ctx };
    } catch (error) {
      warnError(`detectCapabilities(${provider.name})`, error);
    }
  }

  return fallback;
}

async function detectOne(name: ProviderId, factory: ProviderFactory): Promise<ProviderDetection> {
  const provider = factory();
  const apiKey = provider.apiKey();
  if (!provider.isLocal && apiKey.length === 0) {
    return { provider: name, available: false, isLocal: false, hasKey: false };
  }
  try {
    let models: DetectedModel[];
    if (provider.listModelsWithMetadata) {
      models = await withTimeout(provider.listModelsWithMetadata(), DETECTION_TIMEOUT_MS);
    } else {
      const ids = await withTimeout(provider.listModels(), DETECTION_TIMEOUT_MS);
      models = ids.map((id) => ({ id }));
    }
    const lastError = provider.getLastError?.();
    return {
      provider: name,
      available: models.length > 0,
      isLocal: provider.isLocal,
      ...(models.length > 0 ? { models } : {}),
      ...(!provider.isLocal ? { hasKey: apiKey.length > 0 } : {}),
      ...(lastError ? { error: lastError } : {}),
    };
  } catch (error) {
    return {
      provider: name,
      available: false,
      isLocal: provider.isLocal,
      ...(!provider.isLocal ? { hasKey: apiKey.length > 0 } : {}),
      error: toErrorMessage(error),
    };
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
