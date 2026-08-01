import type { Config } from '../../core/schemas/config.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import type { ProviderDef } from './types.js';
import { lookupCatalogContextLength } from './model/catalog.js';
import { warnError } from '../../lib/warn.js';
import { providerError } from './errors.js';
import { getProvider } from './registry.js';

export type ContextLengthOrigin = 'env' | 'config' | 'detected' | 'catalog' | 'fallback';

export interface DetectedCapabilities {
  contextLength: number;
  origin: ContextLengthOrigin;
}

function getImplementerProvider(config: Config): ProviderDef {
  const impl = config.implementer;
  if (impl.kind !== 'api') throw providerError.notApi(impl.kind);
  return getProvider(impl.provider, {
    apiBase: impl.apiBase,
    apiKey: impl.apiKey,
  });
}

function lookupConfiguredCatalogContextLength(config: Config): number | undefined {
  const implementer = config.implementer;
  if (implementer.model === undefined || isAutomaticModel(implementer.model)) return undefined;
  if (implementer.kind === 'api') {
    return lookupCatalogContextLength(implementer.provider, implementer.model);
  }
  if (implementer.kind === 'cli') {
    return lookupCatalogContextLength(implementer.tool, implementer.model);
  }
  return undefined;
}

export async function detectCapabilities(config: Config): Promise<DetectedCapabilities> {
  const envCtx = process.env.SPLITBRIEF_CONTEXT_LENGTH;
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
