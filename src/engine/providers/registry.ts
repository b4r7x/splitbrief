import type { ProviderDef, ProviderOverrides } from './types.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { Config } from '../../core/schemas/config.js';
import type { ProviderDetection } from '../../core/discovery/detection.js';
import { apiKeyEnvReference, validateProviderBaseURL } from './client.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createGroqProvider } from './groq.js';
import { createTogetherProvider } from './together.js';
import { createAnthropicProvider } from './anthropic/adapter.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { PROVIDER_CATALOG, isSameOrigin } from '../../core/providers/catalog.js';
import { isProviderId, type ProviderId } from '../../core/schemas/enums.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { providerError } from './errors.js';
import { error } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';
import { lookupCatalogContextLength } from './model/catalog.js';

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
      createOpenAICompatProvider({
        name: id,
        defaultBaseURL: baseURL,
        envKeyName: apiKeyEnv,
        overrides,
      });
  }
  return out;
}

export const KNOWN_PROVIDERS: Partial<Record<ProviderId, ProviderFactory>> = {
  ...BESPOKE_PROVIDERS,
  ...buildOpenAICompatFactories(),
};

export function getProvider(name: string, overrides?: ProviderOverrides): ProviderDef {
  if (overrides?.apiBase) {
    validateProviderBaseURL(overrides.apiBase);
  }
  const factory = isProviderId(name) ? KNOWN_PROVIDERS[name] : undefined;
  if (factory) {
    if (overrides?.apiBase) {
      rejectApiBaseExfiltration(name, overrides);
    }
    return factory(overrides);
  }
  if (!overrides?.apiBase) throw providerError.unknownNeedsApiBase(name);
  if (!overrides.apiKey) throw providerError.unknownNeedsApiKey(name);
  rejectUnknownProviderEnvApiKeyReference(name, overrides);
  return createOpenAICompatProvider({
    name,
    defaultBaseURL: overrides.apiBase,
    envKeyName: '',
    overrides,
  });
}

function rejectUnknownProviderEnvApiKeyReference(name: string, overrides: ProviderOverrides): void {
  const envVar = apiKeyEnvReference(overrides.apiKey);
  if (!envVar) return;

  const apiBase = redactSecrets(overrides.apiBase ?? '');
  throw error(
    'provider-custom-env-api-key-exfiltration',
    `Custom/unknown provider '${name}' cannot use env apiKey reference env:${envVar} with apiBase '${apiBase}'. ` +
      `This is an API key exfiltration risk; use an inline apiKey for this custom provider.`,
    { provider: name, apiBase, envVar },
  );
}

function rejectApiBaseExfiltration(name: string, overrides: ProviderOverrides): void {
  if (!isProviderId(name)) return;
  const info = PROVIDER_CATALOG[name];
  if (!info.apiKeyEnv) return;
  if (info.baseURL && overrides.apiBase && isSameOrigin(overrides.apiBase, info.baseURL)) return;
  const envRef = apiKeyEnvReference(overrides.apiKey);
  if (overrides.apiKey && !envRef) return;
  const envVar = envRef ?? info.apiKeyEnv;
  const envKey = process.env[envVar];
  if (!envKey) return;
  throw providerError.apiBaseExfiltration(name, envVar);
}

function getImplementerProvider(config: Config): ProviderDef {
  const impl = config.implementer;
  if (impl.kind !== 'api') throw providerError.notApi(impl.kind);
  return getProvider(impl.provider, {
    apiBase: impl.apiBase,
    apiKey: impl.apiKey,
  });
}

export type ContextLengthOrigin = 'env' | 'config' | 'detected' | 'catalog' | 'fallback';

export interface DetectedCapabilities {
  contextLength: number;
  origin: ContextLengthOrigin;
}

function lookupConfiguredCatalogContextLength(config: Config): number | undefined {
  const implementer = config.implementer;
  if (implementer.model === undefined || implementer.model === 'auto') return undefined;
  if (implementer.kind === 'api') {
    return lookupCatalogContextLength(implementer.provider, implementer.model);
  }
  if (implementer.kind === 'cli') {
    return lookupCatalogContextLength(implementer.tool, implementer.model);
  }
  return undefined;
}

export async function detectCapabilities(config: Config): Promise<DetectedCapabilities> {
  const envCtx = process.env.DIPTYCH_CONTEXT_LENGTH;
  const parsed = envCtx ? parseInt(envCtx, 10) : NaN;
  if (!Number.isNaN(parsed)) return { contextLength: parsed, origin: 'env' };

  if (config.implementer.contextLength !== undefined) {
    return { contextLength: config.implementer.contextLength, origin: 'config' };
  }

  if (config.implementer.kind === 'api') {
    const provider = getImplementerProvider(config);
    if (provider.detectContextLength) {
      try {
        const ctx = await provider.detectContextLength(config.implementer.model);
        if (ctx) return { contextLength: ctx, origin: 'detected' };
      } catch (error) {
        warnError(`detectCapabilities(${provider.name})`, error);
      }
    }
  }

  const catalogContextLength = lookupConfiguredCatalogContextLength(config);
  if (catalogContextLength !== undefined) {
    return { contextLength: catalogContextLength, origin: 'catalog' };
  }

  return { contextLength: 32768, origin: 'fallback' };
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
