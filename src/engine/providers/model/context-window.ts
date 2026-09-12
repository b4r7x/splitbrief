import type { ProviderId } from '../../../core/schemas/enums.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import {
  findKnownModel,
  getBundledModels,
  getEffectiveModelId,
  lookupCatalogModelByModelId,
  lookupModelsDevModel,
  lookupRuntimeModel,
  type ModelCacheAccessor,
} from './resolution.js';
import { isCliToolId } from '../../../core/runners/cli-tool-catalog.js';

export type ContextWindowSource = 'models-dev' | 'runtime' | 'known-catalog' | 'automatic-catalog';

export interface ResolvedContextWindow {
  readonly contextLength: number;
  readonly source: ContextWindowSource;
}

function bundledMinimumWindow(providerId: ProviderId): ResolvedContextWindow | null {
  const windows = getBundledModels(providerId)
    .map((model) => model.contextLength)
    .filter((length): length is number => length !== undefined);
  if (windows.length === 0) return null;
  return { contextLength: Math.min(...windows), source: 'automatic-catalog' };
}

export function resolveRunnerContextWindow(
  input: Readonly<{
    providerId: string;
    model?: string | undefined;
    cache?: ModelCacheAccessor | undefined;
  }>,
): ResolvedContextWindow | null {
  if (!isProviderId(input.providerId)) return null;

  const modelId = getEffectiveModelId(input.providerId, input.model);
  if (modelId === undefined) {
    // Automatic selection resolves to no model id; the smallest bundled window
    // is the largest one every model the tool could pick is guaranteed to have.
    return bundledMinimumWindow(input.providerId);
  }

  if (input.cache !== undefined) {
    const modelsDev = lookupModelsDevModel(input.providerId, modelId, input.cache);
    if (modelsDev?.contextLength !== undefined) {
      return { contextLength: modelsDev.contextLength, source: 'models-dev' };
    }

    const runtime = lookupRuntimeModel(input.providerId, modelId, input.cache);
    if (runtime?.contextLength !== undefined) {
      return { contextLength: runtime.contextLength, source: 'runtime' };
    }

    // A CLI tool owns no catalog vendor, so its pinned model is only found by
    // identity — the same lane pricing uses for a vendorless runner.
    if (isCliToolId(input.providerId)) {
      const byIdentity = lookupCatalogModelByModelId(modelId, input.cache);
      if (byIdentity?.contextLength !== undefined) {
        return { contextLength: byIdentity.contextLength, source: 'models-dev' };
      }
    }
  }

  const known = findKnownModel(input.providerId, modelId);

  if (known?.contextLength !== undefined) {
    return { contextLength: known.contextLength, source: 'known-catalog' };
  }

  return null;
}
