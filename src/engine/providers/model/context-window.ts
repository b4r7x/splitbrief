import type { ProviderId } from '../../../core/schemas/enums.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import {
  findKnownModel,
  getBundledModels,
  getEffectiveModelId,
  lookupModelsDevModel,
  lookupRuntimeModel,
  type ModelCacheAccessor,
} from './resolution.js';

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
  }

  const known = findKnownModel(input.providerId, modelId);

  // An alias is not a catalog id, so the lookups above cannot find it: `opus` is `claude-opus-5`
  // in every catalog that publishes a window for it. A row that names the id it resolves to reads
  // that row's window ahead of the one it declares, so a pinned seat and the picker row it was
  // picked from can never print two windows for one model.
  if (input.cache !== undefined && known?.catalogModelId !== undefined) {
    const catalogRow = lookupModelsDevModel(input.providerId, known.catalogModelId, input.cache);
    if (catalogRow?.contextLength !== undefined) {
      return { contextLength: catalogRow.contextLength, source: 'models-dev' };
    }
  }

  if (known?.contextLength !== undefined) {
    return { contextLength: known.contextLength, source: 'known-catalog' };
  }

  return null;
}
