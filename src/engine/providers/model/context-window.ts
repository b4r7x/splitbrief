import type { ProviderId, RunnerKind } from '../../../core/schemas/enums.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import { isApiProviderId } from '../../../core/providers/api-provider-catalog.js';
import { findKnownModel } from '../../../core/providers/known-models.js';
import {
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
    /** The asking runner's kind; decides which lanes may answer. Absent is legacy. */
    kind?: RunnerKind | undefined;
    model?: string | undefined;
    cache?: ModelCacheAccessor | undefined;
  }>,
): ResolvedContextWindow | null {
  // Kind decides first: an API runner named `opencode` is a custom endpoint and
  // must not budget against the local OpenCode CLI catalog, and a CLI runner is
  // never an API catalog provider whatever its name.
  if (input.kind === 'api') {
    if (!isApiProviderId(input.providerId)) return null;
  } else if (input.kind === 'cli') {
    if (!isCliToolId(input.providerId)) return null;
  } else if (input.kind !== undefined) {
    return null;
  } else if (!isProviderId(input.providerId)) {
    return null;
  }
  const providerId: ProviderId = input.providerId;

  const modelId = getEffectiveModelId(providerId, input.model);
  if (modelId === undefined) {
    // Automatic selection resolves to no model id; the smallest bundled window
    // is the largest one every model the tool could pick is guaranteed to have.
    return bundledMinimumWindow(providerId);
  }

  const cliLane = input.kind === undefined ? isCliToolId(providerId) : input.kind === 'cli';
  if (input.cache !== undefined) {
    const modelsDev = lookupModelsDevModel({
      providerId,
      modelId,
      cache: input.cache,
      kind: input.kind,
    });
    if (modelsDev?.contextLength !== undefined) {
      return { contextLength: modelsDev.contextLength, source: 'models-dev' };
    }

    const runtime = lookupRuntimeModel({
      providerId,
      modelId,
      cache: input.cache,
      kind: input.kind,
    });
    if (runtime?.contextLength !== undefined) {
      return { contextLength: runtime.contextLength, source: 'runtime' };
    }

    // A CLI tool owns no catalog vendor, so its pinned model is only found by
    // identity — the same lane pricing uses for a vendorless runner.
    if (cliLane) {
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
