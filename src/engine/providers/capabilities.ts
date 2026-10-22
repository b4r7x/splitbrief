import type { Config } from '../../core/schemas/config.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../core/tokens/context-length.js';
import type { ProviderDef } from './types.js';
import { resolveRunnerContextWindow } from './model/context-window.js';
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
  if (implementer.kind === 'api') {
    // Kind first: an API implementer named `opencode` is a custom endpoint and
    // must not take the local OpenCode CLI bundled window.
    return resolveRunnerContextWindow({
      providerId: implementer.provider,
      kind: 'api',
      model: implementer.model,
    })?.contextLength;
  }
  if (implementer.kind === 'cli') {
    return resolveRunnerContextWindow({
      providerId: implementer.tool,
      kind: 'cli',
      model: implementer.model,
    })?.contextLength;
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
        warnError(
          `Could not read the context length of ${config.implementer.model} from ${provider.name}`,
          error,
        );
      }
    }
  }

  const catalogContextLength = lookupConfiguredCatalogContextLength(config);
  if (catalogContextLength !== undefined) {
    return { contextLength: catalogContextLength, origin: 'catalog' };
  }

  return { contextLength: DEFAULT_UNKNOWN_CONTEXT_LENGTH, origin: 'fallback' };
}
