import type { Config } from '../../core/schemas/config.js';
import type { ProviderDef } from './types.js';
import { resolveRunnerContextWindow } from './model/context-window.js';
import { type ModelCacheAccessor, resolveSeatImageFact } from './model/resolution.js';
import { resolveSeatModel } from '../runners/host-model-selection.js';
import { seatSupportsImages } from '../../core/runners/capabilities.js';
import { warnError } from '../../lib/warn.js';
import { OBSERVATION_HTTP_TIMEOUT_MS } from '../constants.js';
import { providerError } from './errors.js';
import { getProvider } from './registry.js';

export type ContextLengthOrigin = 'config' | 'detected' | 'catalog';

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

/**
 * The window a run routes by, on the same model cache. A CLI seat on `auto` takes the model its tool
 * selects on this host, the model start names on the seat, so boot and run agree on the window.
 */
async function lookupConfiguredCatalogContextLength(
  config: Config,
  cache: ModelCacheAccessor | undefined,
): Promise<number | undefined> {
  const implementer = config.implementer;
  if (implementer.kind === 'api') {
    // Kind first: an API implementer named `opencode` is a custom endpoint and
    // must not take the local OpenCode CLI bundled window.
    return resolveRunnerContextWindow({
      providerId: implementer.provider,
      kind: 'api',
      model: implementer.model,
      cache,
    })?.contextLength;
  }
  if (implementer.kind === 'cli') {
    const seatModel = await resolveSeatModel(
      implementer,
      process.env,
      cache?.getProviderModels(implementer.tool, 'cli') ?? undefined,
    );
    return resolveRunnerContextWindow({
      providerId: implementer.tool,
      kind: 'cli',
      model: seatModel.model,
      cache,
    })?.contextLength;
  }
  return undefined;
}

/** The build seat's context length and where it came from; undefined when no source names one. */
export async function detectCapabilities(
  config: Config,
  modelCache?: ModelCacheAccessor | undefined,
): Promise<DetectedCapabilities | undefined> {
  if (config.implementer.contextLength !== undefined) {
    return { contextLength: config.implementer.contextLength, origin: 'config' };
  }

  if (config.implementer.kind === 'api') {
    const provider = getImplementerProvider(config);
    if (provider.detectContextLength) {
      const signal = AbortSignal.timeout(OBSERVATION_HTTP_TIMEOUT_MS);
      try {
        const ctx = await provider.detectContextLength(config.implementer.model, { signal });
        if (ctx) return { contextLength: ctx, origin: 'detected' };
      } catch (error) {
        // A read past its bound leaves the length unknown; the next source supplies it.
        if (!signal.aborted) {
          warnError(
            `Could not read the context length of ${config.implementer.model} from ${provider.name}`,
            error,
          );
        }
      }
    }
  }

  const catalogContextLength = await lookupConfiguredCatalogContextLength(config, modelCache);
  if (catalogContextLength === undefined) return undefined;
  return { contextLength: catalogContextLength, origin: 'catalog' };
}

/** Whether the planner reads images: its tool's image channel and its own model's fact. */
export function plannerSupportsImages(config: Config | null, cache: ModelCacheAccessor): boolean {
  if (config === null) return false;
  const runner = config.planner;
  return seatSupportsImages({
    runner,
    detected: resolveSeatImageFact({ runner, role: 'planner', cache }),
  });
}
