import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import { findKnownModel, type KnownModel } from '../../../core/providers/known-models.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import { matchesModelsDevId } from './parsing.js';
import type { ResolvedModelCatalogEntry } from './types.js';

export function ownerFor(entry: DetectedModel, fallback: string): string {
  return entry.providerId ?? fallback;
}

function exactModelsDevMetadata(
  input: Readonly<{
    entries: readonly DetectedModel[];
    selectionId: string;
    sourceProviderId?: string | undefined;
  }>,
): DetectedModel | null {
  const matches = input.entries.filter(
    (entry) =>
      matchesModelsDevId({ left: entry.id, right: input.selectionId }) &&
      (input.sourceProviderId === undefined || entry.providerId === input.sourceProviderId),
  );
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

/**
 * The row's own owner is tried first, then any owner: a runner whose models.dev
 * vendor is not its runner id (`copilot` → `github-copilot`) only ever matches
 * on the second try, and an id two vendors both serve stays ambiguous there —
 * so relaxing the owner can add metadata but never swap one row's for another's.
 */
export function metadataForSelection(
  input: Readonly<{
    runnerId: ProviderId;
    selectionId: string;
    sourceProviderId: string;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): DetectedModel | null {
  const direct =
    exactModelsDevMetadata({
      entries: input.modelsDevEntries,
      selectionId: input.selectionId,
      sourceProviderId: input.sourceProviderId,
    }) ??
    exactModelsDevMetadata({
      entries: input.modelsDevEntries,
      selectionId: input.selectionId,
    });
  if (direct !== null) return direct;

  const known = findKnownModel(input.runnerId, input.selectionId);
  if (known === undefined || known.catalogProvider === undefined) return null;
  return exactModelsDevMetadata({
    entries: input.modelsDevEntries,
    selectionId: known.catalogModelId ?? known.name,
    sourceProviderId: known.catalogProvider,
  });
}

export function metadataForBundledModel(
  input: Readonly<{
    model: KnownModel;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): DetectedModel | null {
  const { model } = input;
  const selectionId = model.catalogModelId ?? model.name;
  return exactModelsDevMetadata({
    entries: input.modelsDevEntries,
    selectionId,
    ...(model.catalogProvider === undefined ? {} : { sourceProviderId: model.catalogProvider }),
  });
}

/**
 * External metadata enriches what a runtime row displays; it never states what is installed
 * here. The catalog's own id, owner, load record and observed context stay behind, so a
 * published row can neither rewrite the id the runner executes nor claim a model is loaded
 * on this machine (REQ-045).
 */
function mergeRuntimeMetadata(
  runtime: DetectedModel,
  modelsDev: DetectedModel | null,
): DetectedModel {
  if (modelsDev === null) return runtime;
  const {
    id: _id,
    providerId: _providerId,
    runtime: _runtime,
    effectiveContextTokens: _effectiveContextTokens,
    ...enrichment
  } = modelsDev;
  return { ...enrichment, ...runtime };
}

export function runtimeEntry(
  input: Readonly<{
    runnerId: ProviderId;
    runtimeProviderId: ProviderId;
    model: DetectedModel;
    nativeOrder: number;
    isStale: boolean;
    modelsDevEntries: readonly DetectedModel[];
  }>,
): ResolvedModelCatalogEntry {
  const sourceProviderId = ownerFor(input.model, input.runtimeProviderId);
  const metadata = metadataForSelection({
    runnerId: input.runnerId,
    selectionId: input.model.id,
    sourceProviderId,
    modelsDevEntries: input.modelsDevEntries,
  });
  const merged = mergeRuntimeMetadata(input.model, metadata);
  return {
    ...merged,
    id: input.model.id,
    selectionId: input.model.id,
    runnerId: input.runnerId,
    sourceProviderId,
    isDetected: !input.isStale,
    nativeOrder: input.model.nativeOrder ?? input.nativeOrder,
    source: 'runtime',
    membership: input.isStale ? 'stale' : 'confirmed',
    ...(input.isStale ? { isStale: true } : {}),
    canConfigure: true,
  };
}
