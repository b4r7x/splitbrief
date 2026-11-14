import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { KnownModel } from '../../../core/providers/known-models.js';
import type { ProviderId } from '../../../core/schemas/enums.js';
import { getPricingMode } from '../cost/pricing.js';
import { ownerFor, stripUnpricedFields, metadataForBundledModel } from './entry-metadata.js';
import type { ResolvedModelCatalogEntry } from './types.js';

/** The models.dev catalog lane's membership — produced for `api` runners only (REQ-B08). */
export const CATALOG_SUGGESTION_MEMBERSHIP = 'catalog-suggestion';

export function modelsDevSuggestion(
  input: Readonly<{
    runnerId: ProviderId;
    model: DetectedModel;
  }>,
): ResolvedModelCatalogEntry {
  const sourceProviderId = ownerFor(input.model, input.runnerId);
  return stripUnpricedFields({
    ...input.model,
    id: input.model.id,
    selectionId: input.model.id,
    runnerId: input.runnerId,
    sourceProviderId,
    isDetected: false,
    source: 'models-dev',
    membership: CATALOG_SUGGESTION_MEMBERSHIP,
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

export function bundledSuggestion(
  input: Readonly<{
    runnerId: ProviderId;
    model: KnownModel;
    modelsDevEntries: readonly DetectedModel[];
    keepBundledDefault: boolean;
    nativeOrder: number;
  }>,
): ResolvedModelCatalogEntry {
  const sourceProviderId = input.runnerId;
  const metadata = metadataForBundledModel({
    model: input.model,
    modelsDevEntries: input.modelsDevEntries,
  });
  // A row that names the catalog id it is enriched from has said where its numbers live, so the
  // catalog's window wins there and the declared one is the offline answer only — what the row
  // shows before a catalog loads and the floor `bundledMinimumWindow` reads (REQ-D26). Without
  // this, a claude-code alias would print its own copy of a number models.dev is re-publishing,
  // and the two would drift apart on their own schedules. A row that declares a window and names
  // no catalog id keeps it: there the tool's own probe is the authority on what the tool accepts.
  const declaredWindow =
    input.model.catalogModelId !== undefined && metadata?.contextLength !== undefined
      ? undefined
      : input.model.contextLength;
  const base: DetectedModel = {
    id: input.model.name,
    // The alias is the only thing that tells these rows apart, so its own identity outranks the
    // enrichment: four claude-code aliases resolve to one models.dev row and would otherwise all
    // paint that row's name. Numbers still arrive from `metadata`.
    ...(input.model.displayName === undefined ? {} : { displayName: input.model.displayName }),
    ...(input.model.detail === undefined ? {} : { detail: input.model.detail }),
    ...(declaredWindow === undefined ? {} : { contextLength: declaredWindow }),
    ...(input.model.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.model.maxOutputTokens }),
    ...(input.model.pricingInput === undefined ? {} : { pricingInput: input.model.pricingInput }),
    ...(input.model.pricingOutput === undefined
      ? {}
      : { pricingOutput: input.model.pricingOutput }),
    ...(input.model.pricingCacheRead === undefined
      ? {}
      : { pricingCacheRead: input.model.pricingCacheRead }),
    ...(input.model.pricingCacheWrite === undefined
      ? {}
      : { pricingCacheWrite: input.model.pricingCacheWrite }),
    ...(input.model.isFree === undefined ? {} : { isFree: input.model.isFree }),
  };
  const merged = metadata === null ? base : { ...metadata, ...base };
  return stripUnpricedFields({
    ...merged,
    id: input.model.name,
    selectionId: input.model.name,
    runnerId: input.runnerId,
    sourceProviderId,
    // A bundled row whose own id already is the catalog id would restate itself,
    // so only a true alias carries the id it resolves to.
    ...(input.model.catalogModelId !== undefined && input.model.catalogModelId !== input.model.name
      ? { catalogModelId: input.model.catalogModelId }
      : {}),
    ...(input.keepBundledDefault && input.model.isDefault ? { isDefault: true } : {}),
    isDetected: false,
    nativeOrder: input.nativeOrder,
    source: 'bundled-fallback',
    membership: 'bundled-suggestion',
    canConfigure: true,
    pricingMode: getPricingMode(input.runnerId),
  });
}

function lifecycleRank(lifecycle: string | undefined): number {
  return lifecycle?.toLowerCase() === 'deprecated' ? 1 : 0;
}

export function compareSuggestions(
  left: ResolvedModelCatalogEntry,
  right: ResolvedModelCatalogEntry,
): number {
  const lifecycleDifference = lifecycleRank(left.lifecycle) - lifecycleRank(right.lifecycle);
  if (lifecycleDifference !== 0) return lifecycleDifference;

  const releaseDifference = (right.releaseDate ?? '').localeCompare(left.releaseDate ?? '');
  if (releaseDifference !== 0) return releaseDifference;

  const displayDifference = (left.displayName ?? left.id).localeCompare(
    right.displayName ?? right.id,
  );
  if (displayDifference !== 0) return displayDifference;

  const idDifference = left.id.localeCompare(right.id);
  if (idDifference !== 0) return idDifference;
  return left.sourceProviderId.localeCompare(right.sourceProviderId);
}
