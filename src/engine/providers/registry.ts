import type { ProviderDef, ProviderDetection, ProviderOverrides } from './types.js';
import { createOllamaProvider } from './ollama.js';
import { createLmStudioProvider } from './lm-studio.js';
import { createDeepSeekProvider } from './deepseek.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createGenericProvider } from './generic.js';

export const DETECTION_TIMEOUT_MS = 5000;

export const KNOWN_PROVIDERS: Record<string, (overrides?: ProviderOverrides) => ProviderDef> = {
  ollama: createOllamaProvider,
  'lm-studio': createLmStudioProvider,
  deepseek: createDeepSeekProvider,
  openrouter: createOpenRouterProvider,
};

export const KNOWN_PROVIDER_NAMES = Object.keys(KNOWN_PROVIDERS);

export function getProvider(name: string, overrides?: ProviderOverrides): ProviderDef {
  const factory = KNOWN_PROVIDERS[name];
  if (factory) return factory(overrides);
  return createGenericProvider(name, overrides?.apiBase ?? '', overrides?.apiKey);
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
        };
      } catch {
        return { provider: name, available: false, isLocal: provider.isLocal };
      }
    }),
  );
}
