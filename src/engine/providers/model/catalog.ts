import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { areExactModelSelectionIdsEqual } from '../../../core/providers/canonical-model-id.js';
import { isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import { isApiProviderId } from '../../../core/providers/api-provider-catalog.js';
import { isProviderId, type ProviderId, type RunnerKind } from '../../../core/schemas/enums.js';
import { modelRowLanes } from './lane-policy.js';
import { getModelsDevEntries } from './resolution.js';
import { getRuntimeModelSnapshot } from './runtime-snapshot.js';
import { getBundledModels } from './runtime-snapshot.js';
import { NULL_CACHE } from './runtime-snapshot.js';
import type { ModelCacheAccessor } from './runtime-snapshot.js';
import type { ResolvedModelCatalogEntry, ResolveModelCatalogOptions } from './types.js';
import { ownerFor, runtimeEntry } from './entry-metadata.js';
import { bundledSuggestion, compareSuggestions, modelsDevSuggestion } from './suggestions.js';
import { claudeCodeOptionEntry, configuredRecovery } from './claude-code-options.js';
import {
  type CanonicalIndex,
  indexCanonically,
  indexNamesSameModel,
  aliasAnsweringToOptionId,
  withAliasDetail,
} from './canonical-index.js';
import { withToolEffortFloor, withCatalogNames } from './names.js';

/** The type facts a listing uses to say a model answers with vectors, not text. */
const EMBEDDING_TYPE_FACTS = new Set([
  'embedding',
  'embeddings',
  'type:embedding',
  'type:embeddings',
]);

/**
 * Only the model's own positive evidence disqualifies it: a type fact naming an embedding
 * model, output modalities that name no text, or output in another medium from a model that
 * takes no tool calls — an image or music generator, which a seat's tool cannot run. Tool-call
 * training alone is not that evidence — a local text model that was never trained on tools
 * still answers an API contract that sends none, and dropping it made a working LM Studio
 * model unselectable (REQ-046).
 */
function isChatCapable(model: DetectedModel): boolean {
  const facts = model.capabilities ?? [];
  if (facts.some((fact) => EMBEDDING_TYPE_FACTS.has(fact.trim().toLowerCase()))) return false;
  const output = model.outputModalities;
  if (output === undefined) return true;
  if (!output.includes('text')) return false;
  return model.supportsToolCalls !== false || output.every((medium) => medium === 'text');
}

function entryKey(input: Readonly<{ owner: string; selectionId: string }>): string {
  return `${input.owner}\u0000${input.selectionId}`;
}

function runtimeModels(input: {
  providerId: ProviderId;
  cache: ModelCacheAccessor;
  role: ActiveRunnerRole | undefined;
  kind: RunnerKind | undefined;
}): ReturnType<typeof getRuntimeModelSnapshot> {
  const { providerId, cache, role, kind } = input;
  return getRuntimeModelSnapshot({
    providerId,
    cache,
    role,
    ...(kind === undefined ? {} : { kind }),
  });
}

function configuredSelectionId(
  input: Readonly<{ providerId: ProviderId; selectionId: string | undefined }>,
): string | null {
  if (
    input.selectionId === undefined ||
    input.selectionId.trim() === '' ||
    isAutomaticModel(input.selectionId, input.providerId)
  ) {
    return null;
  }
  return input.selectionId;
}

function hasExactSelection(
  entries: readonly ResolvedModelCatalogEntry[],
  selectionId: string,
): boolean {
  return entries.some((entry) =>
    areExactModelSelectionIdsEqual({ left: entry.selectionId, right: selectionId }),
  );
}

function resolveCatalogEntries(
  input: Readonly<{
    providerId: ProviderId;
    cache: ModelCacheAccessor;
    configuredSelectionId?: string | undefined;
    role?: ActiveRunnerRole | undefined;
    browseCatalog?: boolean | undefined;
    kind?: RunnerKind | undefined;
  }>,
): ResolvedModelCatalogEntry[] {
  const { providerId, cache } = input;
  const modelsDevEntries = getModelsDevEntries({ providerId, cache, kind: input.kind });
  const runtimeSnapshot = runtimeModels({ providerId, cache, role: input.role, kind: input.kind });
  const runtime = runtimeSnapshot?.entries ?? [];
  const runtimeRows: ResolvedModelCatalogEntry[] = [];
  const runtimeKeys = new Set<string>();
  const runtimeIndex: CanonicalIndex = new Map();
  const lanes = modelRowLanes({
    providerId,
    hasRuntimeList: runtime.length > 0,
    browseCatalog: input.browseCatalog,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
  });

  runtime.forEach((model, nativeOrder) => {
    if (!isChatCapable(model)) return;
    const owner = ownerFor(model, runtimeSnapshot?.providerId ?? providerId);
    const key = entryKey({ owner, selectionId: model.id });
    if (runtimeKeys.has(key)) return;
    runtimeKeys.add(key);
    const row = runtimeEntry({
      runnerId: providerId,
      runtimeProviderId: runtimeSnapshot?.providerId ?? providerId,
      model,
      nativeOrder,
      isStale: runtimeSnapshot?.isStale ?? false,
      modelsDevEntries,
    });
    runtimeRows.push(row);
    indexCanonically(runtimeIndex, row);
  });

  const modelsDevRows: ResolvedModelCatalogEntry[] = [];
  const modelsDevKeys = new Set<string>();
  if (lanes.modelsDev) {
    for (const model of modelsDevEntries) {
      const owner = ownerFor(model, providerId);
      const key = entryKey({ owner, selectionId: model.id });
      if (modelsDevKeys.has(key)) continue;
      if (indexNamesSameModel(runtimeIndex, { id: model.id, owner })) continue;
      modelsDevKeys.add(key);
      modelsDevRows.push(modelsDevSuggestion({ runnerId: providerId, model }));
    }
  }

  const bundledRows: ResolvedModelCatalogEntry[] = [];
  const bundledKeys = new Set<string>();
  if (lanes.bundled) {
    const keepBundledDefault = runtimeSnapshot === null;
    for (const [nativeOrder, model] of getBundledModels(providerId).entries()) {
      const key = entryKey({ owner: providerId, selectionId: model.name });
      if (modelsDevKeys.has(key) || bundledKeys.has(key)) continue;
      if (indexNamesSameModel(runtimeIndex, { id: model.name, owner: providerId })) continue;
      bundledKeys.add(key);
      bundledRows.push(
        bundledSuggestion({
          runnerId: providerId,
          model,
          modelsDevEntries,
          keepBundledDefault,
          nativeOrder,
        }),
      );
    }
  }

  const claudeCodeOptionRows: ResolvedModelCatalogEntry[] = [];
  const aliasDetails = new Map<string, string>();
  if (lanes.claudeCodeOptions) {
    for (const option of cache.getClaudeCodeModelOptions?.() ?? []) {
      if (indexNamesSameModel(runtimeIndex, { id: option.id, owner: providerId })) continue;
      const alias = aliasAnsweringToOptionId(providerId, option.id);
      if (
        alias !== undefined &&
        bundledKeys.has(entryKey({ owner: providerId, selectionId: alias.name }))
      ) {
        if (option.description !== undefined) aliasDetails.set(alias.name, option.description);
        continue;
      }
      claudeCodeOptionRows.push(
        claudeCodeOptionEntry({ runnerId: providerId, option, modelsDevEntries }),
      );
    }
  }

  const catalogRows = [
    ...runtimeRows,
    ...modelsDevRows.sort(compareSuggestions),
    ...bundledRows.sort(compareSuggestions).map((row) => withAliasDetail(row, aliasDetails)),
    ...claudeCodeOptionRows,
  ];
  const configured = configuredSelectionId({
    providerId,
    selectionId: input.configuredSelectionId,
  });
  if (configured === null || hasExactSelection(catalogRows, configured)) return catalogRows;

  return [
    configuredRecovery({ runnerId: providerId, selectionId: configured, modelsDevEntries }),
    ...catalogRows,
  ];
}

export function resolveModelCatalog(
  providerId: string,
  options: ResolveModelCatalogOptions = {},
): ResolvedModelCatalogEntry[] {
  if (!isProviderId(providerId)) return [];
  const { kind } = options;
  // A CLI tool's rows belong to the CLI runner; an API runner that happens to
  // reuse the tool's name as a custom provider is not that runner. Only a
  // caller that passes no kind keeps the legacy name-only lane choice.
  if (kind === 'api' && !isApiProviderId(providerId)) return [];
  if (kind === 'cli' && !isCliToolId(providerId)) return [];
  if (kind !== undefined && kind !== 'api' && kind !== 'cli') return [];
  const cache = options.cache ?? NULL_CACHE;
  return withToolEffortFloor(
    providerId,
    withCatalogNames(
      providerId,
      cache,
      resolveCatalogEntries({
        providerId,
        cache,
        configuredSelectionId: options.configuredSelectionId,
        role: options.role,
        browseCatalog: options.browseCatalog,
        ...(kind === undefined ? {} : { kind }),
      }),
    ),
  );
}
