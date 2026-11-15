import { mergeCatalogRead } from '../../../core/discovery/catalog-read-merge.js';
import { cloneDetectedModel } from '../../../core/discovery/clone-model.js';
import type { RememberedCliCatalog } from '../cache/schema.js';
import { loadRememberedSnapshot, saveDetectionCache } from '../cache/store.js';
import type { CliModelSnapshot, DetectionProjection, DetectionSourceOutcome } from '../types.js';
import { cloneProjection } from './results.js';
import type { DetectionServiceState } from './types.js';

function probedCliCatalogs(
  outcome: DetectionSourceOutcome<CliModelSnapshot>,
): RememberedCliCatalog[] {
  if (outcome.kind !== 'fresh' || outcome.origin !== 'request') return [];
  const probedAt = outcome.snapshot.fetchedAt;
  return outcome.snapshot.value.flatMap((attempt) =>
    attempt.outcome.kind === 'success'
      ? [
          {
            tool: attempt.connection.tool,
            models: attempt.outcome.value.map(cloneDetectedModel),
            ...(attempt.namesProject === true ? { namesProject: true } : {}),
            probedAt,
          },
        ]
      : [],
  );
}

function rememberedCliCatalogs(
  probed: readonly RememberedCliCatalog[],
  previous: readonly RememberedCliCatalog[],
): RememberedCliCatalog[] {
  const probedTools = new Set(probed.map((catalog) => catalog.tool));
  const merged = probed.map((catalog): RememberedCliCatalog => {
    const remembered = previous.find((entry) => entry.tool === catalog.tool);
    const read = mergeCatalogRead({
      cachedModels: remembered?.models,
      missingOnce: remembered?.missingOnce,
      readModels: catalog.models,
    });
    return {
      tool: catalog.tool,
      models: read.models,
      ...(read.missingOnce.length === 0 ? {} : { missingOnce: read.missingOnce }),
      ...(catalog.namesProject === true ? { namesProject: true } : {}),
      probedAt: read.complete ? catalog.probedAt : (remembered?.probedAt ?? 0),
    };
  });
  return [...merged, ...previous.filter((catalog) => !probedTools.has(catalog.tool))];
}

export function queueSave(
  state: DetectionServiceState,
  input: Readonly<{
    projectDir: string | undefined;
    outcome: DetectionSourceOutcome<DetectionProjection>;
    cliModels: DetectionSourceOutcome<CliModelSnapshot>;
  }>,
): void {
  if (!state.acceptingSaves) return;
  const projectDir = input.projectDir;
  if (projectDir === undefined || input.outcome.kind !== 'fresh') return;
  // A TTL-hydrated readiness snapshot still persists when the CLI catalog
  // lane ran a real probe this request — fresh model rows must not be lost.
  const cliModelsProbed = input.cliModels.kind === 'fresh' && input.cliModels.origin === 'request';
  if (input.outcome.origin !== 'request' && !cliModelsProbed) return;
  const requestId = input.outcome.snapshot.requestId;
  if (state.persistedRequestIds.has(requestId)) return;

  state.persistedRequestIds.add(requestId);
  const snapshot = input.outcome.snapshot;
  const projection = cloneProjection(snapshot.value);
  const probed = probedCliCatalogs(input.cliModels);
  state.pendingSave = state.pendingSave.then(async () => {
    const previous = (await loadRememberedSnapshot(projectDir))?.cliCatalogs ?? [];
    const cliCatalogs = rememberedCliCatalogs(probed, previous);
    await saveDetectionCache({
      projectDir,
      snapshot: {
        contextKey: snapshot.contextKey,
        fetchedAt: snapshot.fetchedAt,
        validatedAt: snapshot.validatedAt,
        generation: snapshot.generation,
        requestId: snapshot.requestId,
        // Disk cache stays the sanitized presentation projection. Role scoped
        // provider outcomes remain memory-only because they carry catalog
        // membership and connection-scoped diagnostics; remembered model rows
        // are re-sanitized to the cached subset inside saveDetectionCache.
        providers: projection.providers,
        cliTools: projection.cliTools,
        ...(cliCatalogs.length === 0 ? {} : { cliCatalogs }),
      },
    });
  });
}
