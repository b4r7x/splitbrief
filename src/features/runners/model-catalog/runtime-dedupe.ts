import { resolveModelDisplayName } from '../../../core/discovery/model-catalog.js';
import {
  type ModelIdentity,
  canonicalModelBucket,
  isSameCanonicalModel,
} from '../../../core/providers/canonical-model-id.js';
import { isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import {
  resolveModelCatalog,
  type ResolvedModelCatalogEntry,
} from '../../../engine/providers/model/catalog.js';
import { type ModelCacheAccessor, NULL_CACHE } from '../../../engine/providers/model/resolution.js';
import { type ModelOption, sortModelsByRecency } from './recency.js';

/**
 * A row no catalog knows anything about says so, rather than leaving its metadata column blank —
 * where a catalog is what the row is looked up in. A CLI tool's own listing is its catalog, so a row
 * it lists without a size lacks nothing a lookup could have found.
 */
const NO_CATALOG_ENTRY_DETAIL = 'no catalog entry';

function toModelOption(entry: ReturnType<typeof resolveModelCatalog>[number]): ModelOption {
  const displayName = resolveModelDisplayName(entry);
  const isNamed = displayName !== entry.id;
  const knowsNothing =
    !isCliToolId(entry.runnerId) &&
    !isNamed &&
    entry.contextLength === undefined &&
    entry.releaseDate === undefined;
  const detail = entry.detail ?? (knowsNothing ? NO_CATALOG_ENTRY_DETAIL : undefined);
  return {
    id: entry.id,
    ...(isNamed ? { displayName } : {}),
    ...(detail === undefined ? {} : { detail }),
    ...(entry.supportsToolCalls === undefined
      ? {}
      : { supportsToolCalls: entry.supportsToolCalls }),
    ...(entry.catalogModelId === undefined ? {} : { catalogModelId: entry.catalogModelId }),
    isDefault: entry.isDefault,
    isDetected: entry.membership === 'confirmed',
    membership: entry.membership,
    ...(entry.isStale ? { isStale: true } : {}),
    ...(entry.nativeOrder === undefined ? {} : { nativeOrder: entry.nativeOrder }),
    ...(entry.source === 'account-options' ? { isAccountOption: true } : {}),
    contextLength: entry.contextLength,
    releaseDate: entry.releaseDate,
    ...(entry.nativeReasoningEfforts === undefined
      ? {}
      : { effortChoices: [...entry.nativeReasoningEfforts] }),
    ...(entry.effortFromFloor === true ? { effortChoicesFromFloor: true } : {}),
  };
}

function identityOf(entry: ResolvedModelCatalogEntry): ModelIdentity {
  return { id: entry.selectionId, owner: entry.sourceProviderId };
}

/** Candidates that share a last canonical segment — every match has one. */
function bucketOf(
  buckets: Map<string, ResolvedModelCatalogEntry[]>,
  identity: ModelIdentity,
): ResolvedModelCatalogEntry[] {
  const key = canonicalModelBucket(identity);
  const existing = buckets.get(key);
  if (existing !== undefined) return existing;
  const created: ResolvedModelCatalogEntry[] = [];
  buckets.set(key, created);
  return created;
}

/**
 * Two runtime rows are two routes the tool really offers — `anthropic/x` and
 * `openrouter/anthropic/x` bill differently — so they collapse only on an exact
 * id, and `mergeProviderVariants` decides which routes are one model. Everything
 * speculative folds into whatever the runtime lane already names.
 */
function dedupeAgainstRuntime(
  entries: readonly ResolvedModelCatalogEntry[],
): ResolvedModelCatalogEntry[] {
  const buckets = new Map<string, ResolvedModelCatalogEntry[]>();
  const runtimeIds = new Set<string>();
  const runtime: ResolvedModelCatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.source !== 'runtime' || runtimeIds.has(entry.selectionId)) continue;
    runtimeIds.add(entry.selectionId);
    bucketOf(buckets, identityOf(entry)).push(entry);
    runtime.push(entry);
  }

  const rest: ResolvedModelCatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.source === 'runtime') continue;
    const identity = identityOf(entry);
    const bucket = bucketOf(buckets, identity);
    if (bucket.some((earlier) => isSameCanonicalModel(identityOf(earlier), identity))) continue;
    bucket.push(entry);
    rest.push(entry);
  }
  return [...runtime, ...rest];
}

export function resolveAndSort(
  providerId: string,
  role: ActiveRunnerRole,
  cache: ModelCacheAccessor = NULL_CACHE,
  options: Readonly<{
    configuredSelectionId?: string | undefined;
    browseCatalog?: boolean | undefined;
  }> = {},
): ModelOption[] {
  const entries = resolveModelCatalog(providerId, {
    cache,
    role,
    configuredSelectionId: options.configuredSelectionId,
    browseCatalog: options.browseCatalog,
  });
  // A model no seat can run never reaches here — `isChatCapable` drops it at the engine. A hidden
  // one can run, so it leaves only this picker, and a seat already on one keeps its row. codex
  // still runs a hidden slug through `-m`.
  const offered = entries.filter(
    (entry) => entry.nativeHidden !== true || entry.selectionId === options.configuredSelectionId,
  );
  // Two lanes may spell one id with different owners; the picker lists a selection once.
  const byId = new Map<string, ModelOption>();
  for (const row of dedupeAgainstRuntime(offered).map(toModelOption)) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return sortModelsByRecency([...byId.values()]);
}
